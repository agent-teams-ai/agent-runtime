import assert from "node:assert/strict";
import {spawn, execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync, realpathSync, statSync} from "node:fs";
import {createInterface} from "node:readline";

// Test infrastructure only. The whole test must already run under `unshare --net`.
// Both interfaces are created inside that disposable namespace; never in the
// machine's initial namespace. This helper neither installs nor proves a route.
const tool = candidates => {
  for (const candidate of candidates) {
    let path;
    try {path = realpathSync(candidate);} catch {continue;}
    const facts = statSync(path);
    assert.ok(facts.isFile() && facts.uid === 0 && !(facts.mode & 0o022), path);
    return Object.freeze({path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex")});
  }
  throw new Error(`Missing installed test tool: ${candidates.join(", ")}`);
};
const namespace = path => {
  const value = statSync(path, {bigint: true});
  return `${value.dev}:${value.ino}`;
};
const childSource = `
  const {createInterface} = await import("node:readline");
  const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
  send({kind: "ready", pid: process.pid});
  const watchdog = setTimeout(() => process.exit(72), 120000);
  const lines = createInterface({input: process.stdin});
  lines.on("line", async line => {
    const {id, url, timeout} = JSON.parse(line);
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(timeout)});
      const text = await response.text();
      send({id, status: response.status, text});
    } catch (error) {send({id, error: error.name});}
  });
  lines.on("close", () => {clearTimeout(watchdog); process.exit(0);});
`;

const command = (binary, args) => execFileSync(binary, args, {
    timeout: 3000, maxBuffer: 65536, encoding: "utf8",
    env: {PATH: "/usr/sbin:/usr/bin:/bin", LANG: "C", LC_ALL: "C"},
  });

export const openJoinedNetwork = async () => {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.geteuid(), 0);
  const outer = namespace("/proc/self/ns/net");
  assert.notEqual(outer, namespace("/proc/1/ns/net"), "run the complete test in a new network namespace");
  const ip = tool(["/usr/sbin/ip", "/usr/bin/ip"]);
  const unshare = tool(["/usr/bin/unshare"]);
  const nsenter = tool(["/usr/bin/nsenter"]);
  const nft = tool(["/usr/sbin/nft", "/usr/bin/nft"]);
  const hostCommand = args => {
    assert.equal(namespace("/proc/self/ns/net"), outer);
    return command(ip.path, args);
  };
  const interfaces = JSON.parse(hostCommand(["-j", "link", "show"]));
  assert.deepEqual(interfaces.map(value => value.ifname), ["lo"], "fixture requires a fresh empty outer namespace");
  const child = spawn(unshare.path, ["--net", "--", process.execPath, "--input-type=module", "-e", childSource], {
    env: {PATH: "/usr/sbin:/usr/bin:/bin", LANG: "C", LC_ALL: "C"}, stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const pending = new Map();
  let ended = false;
  let sequence = 0;
  let linkCreated = false;
  let disposal;
  let diagnosticBytes = 0;
  child.stdin.on("error", () => {});
  const fail = error => {
    ready.reject(error);
    for (const request of pending.values()) {clearTimeout(request.timer); request.reject(error);}
    pending.clear();
  };
  child.once("error", error => {ended = true; fail(error); exited.resolve();});
  child.once("exit", () => {ended = true; fail(new Error("test namespace child exited")); exited.resolve();});
  child.stderr.on("data", bytes => {
    diagnosticBytes += bytes.length;
    if (diagnosticBytes > 4096) {fail(new Error("test child diagnostics exceeded bound")); child.kill("SIGKILL");}
  });
  const lines = createInterface({input: child.stdout});
  lines.on("line", line => {
    try {
      assert.ok(line.length <= 8192);
      const message = JSON.parse(line);
      if (message.kind === "ready") {ready.resolve(message.pid); return;}
      const request = pending.get(message.id);
      assert.ok(request, "unexpected child response");
      clearTimeout(request.timer); pending.delete(message.id); request.resolve(message);
    } catch (error) {fail(error); child.kill("SIGKILL");}
  });
  const dispose = () => disposal ??= (async () => {
    if (!ended) {child.kill("SIGKILL");}
    await exited.promise;
    lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    if (linkCreated) {
      // Moving the peer into the child makes child exit delete both ends.
      const remaining = JSON.parse(hostCommand(["-j", "link", "show"]));
      if (remaining.some(value => value.ifname === "joinhost")) {hostCommand(["link", "delete", "joinhost"]);}
    }
  })();
  const timer = setTimeout(() => {ready.reject(new Error("test namespace readiness timeout")); child.kill("SIGKILL");}, 5000);
  try {
    const pid = await ready.promise;
    assert.equal(pid, child.pid, "unshare must exec the retained child");
    const childNamespace = namespace(`/proc/${pid}/ns/net`);
    assert.notEqual(childNamespace, outer);
    const childCommand = args => {
      assert.equal(ended, false);
      assert.equal(namespace(`/proc/${pid}/ns/net`), childNamespace);
      return command(nsenter.path, ["--net", `--target=${pid}`, "--", ip.path, ...args]);
    };
    hostCommand(["link", "set", "lo", "up"]);
    hostCommand(["link", "add", "joinhost", "type", "veth", "peer", "name", "joinchild"]);
    linkCreated = true;
    hostCommand(["link", "set", "joinchild", "netns", String(pid)]);
    hostCommand(["addr", "add", "172.30.0.1/30", "dev", "joinhost"]);
    hostCommand(["link", "set", "joinhost", "up"]);
    childCommand(["link", "set", "lo", "up"]);
    childCommand(["addr", "add", "172.30.0.2/30", "dev", "joinchild"]);
    childCommand(["link", "set", "joinchild", "up"]);
    return Object.freeze({pid, nsenter, nft, gateway: "172.30.0.1", address: "172.30.0.2", dispose,
      request(url, timeout = 2000) {
        assert.equal(ended, false);
        assert.ok(Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 5000);
        const parsed = new URL(url);
        assert.equal(parsed.protocol, "http:"); assert.equal(parsed.hostname, "172.30.0.1");
        const id = ++sequence; const result = Promise.withResolvers();
        const requestTimer = setTimeout(() => {pending.delete(id); result.reject(new Error("test child request stalled"));}, timeout + 1000);
        pending.set(id, {...result, timer: requestTimer});
        child.stdin.write(JSON.stringify({id, url, timeout}) + "\n");
        return result.promise;
      },
    });
  } catch (error) {await dispose(); throw error;}
  finally {clearTimeout(timer);}
};
