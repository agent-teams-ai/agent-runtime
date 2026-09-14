import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {PassThrough} from "node:stream";
import {networkFixture} from "./external/agent-execution/fixtures/docker-operation-network-fixture.ts";
import {syntheticDaemon} from "./external/agent-execution/fixtures/docker-engine-synthetic-daemon.ts";
import {CONTAINER, DAEMON_BOOT} from "./external/agent-execution/fixtures/docker-engine-test-fixture.ts";
import {archive, chunks, imageLock, IMAGE_CONFIG, NODE_BYTES, BOOTSTRAP_BYTES} from "./external/agent-execution/fixtures/docker-image-init-fixture.ts";
import {FixtureResidueIo, statText, privilegeText} from "../../support/external/agent-execution/features/contained-agent-turn/support/linux-docker-residue-fixture.ts";
import {MemoryStorage} from "../../support/external/agent-execution/features/contained-agent-turn/support/docker-host-custody-lifecycle-fixture.ts";
import {NodeUnixSocketDockerEngine,composeLinuxDockerResidueCustody,PROC_SUPER_MAGIC,residueParent,residueLeaf,DOCKER_CUSTODY_NODE_PATH,DOCKER_CUSTODY_BOOTSTRAP_PATH,DOCKER_CUSTODY_INIT_ARGUMENTS,DockerCustodyFrameDecoder,encodeDockerCustodyFrame,DOCKER_CUSTODY_INIT_PROTOCOL} from
  "@agent-teams/agent-execution/composition";

const json = value => ({statusCode: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(value))});
const hash = value => createHash("sha256").update(value).digest("hex");

// Only external Docker/OS metadata and the init protocol peer are synthetic.
// Production Engine decoding, image/archive verification, residue lifecycle,
// resource network owner and route adapter consume the same operation binding.
export const joinedDocker = ({policy, create, network, bootId}) => {
  const daemon = syntheticDaemon();
  const endpoint = {canonicalSocketPath: policy.socketPath, daemonBootGenerationSha256: DAEMON_BOOT,
    hostBootGenerationSha256: hash(bootId)};
  const info = {ID: "persistent-synthetic-daemon", ServerVersion: "29.6.1", Driver: "overlay2",
    CgroupDriver: "systemd", CgroupVersion: "2"};
  const lock = imageLock(create.imageDigest);
  const parent = `/sys/fs/cgroup${residueParent(policy.cgroupParent, "systemd")}`;
  const io = new FixtureResidueIo(parent);
  io.node("/proc/sys/kernel/random/boot_id").contents = `${bootId}\n`;
  const leaf = `${parent}/${residueLeaf(CONTAINER, "systemd")}`;
  const storage = new MemoryStorage();
  const messages = [];
  let wire;
  let composed;
  let boundEngine;
  let output;
  let closed = false;
  let protocolConsumer;
  const push = message => {
    assert.ok(output && !closed, "init channel unavailable");
    const bytes = encodeDockerCustodyFrame(message);
    const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(bytes.byteLength, 4);
    output.write(Buffer.concat([header, bytes]));
  };
  daemon.inspectTransform = raw => {
    const body = daemon.bodies.at(-1);
    assert.ok(body && wire, "inspection before exact operation binding");
    raw.HostConfig = body.HostConfig;
    raw.Image = IMAGE_CONFIG; raw.Path = DOCKER_CUSTODY_NODE_PATH; raw.Args = [...DOCKER_CUSTODY_INIT_ARGUMENTS];
    raw.Config.Image = create.imageDigest;
    raw.State.Pid = raw.State.Running ? network.pid : 0;
    raw.NetworkSettings = wire.state.containerRaw.NetworkSettings;
  };
  const populate = () => {
    io.group(leaf);
    io.node(`${leaf}/cgroup.procs`).contents = `${network.pid}\n`;
    io.node(`${leaf}/cgroup.events`).contents = "populated 1\nfrozen 0\n";
    io.node(`${parent}/cgroup.events`).contents = "populated 1\nfrozen 0\n";
    const proc = `/proc/${network.pid}`;
    io.directory(proc, PROC_SUPER_MAGIC, 65532);
    io.file(`${proc}/stat`, statText(network.pid), 65532);
    io.file(`${proc}/cgroup`, `0::${leaf.slice("/sys/fs/cgroup".length)}\n`, 65532);
    io.file(`${proc}/status`, privilegeText(), 65532);
  };
  const clearPopulation = () => {
    if (io.nodes.has(leaf)) {
      io.node(`${leaf}/cgroup.procs`).contents = "";
      io.node(`${leaf}/cgroup.events`).contents = "populated 0\nfrozen 0\n";
    }
    io.node(`${parent}/cgroup.events`).contents = "populated 0\nfrozen 0\n";
  };
  const client = {
    async endpointIdentity() {return {...endpoint};},
    async buffered(request) {
      if (request.path === "/v1.47/info") {return json(info);}
      if (request.path.startsWith("/v1.47/networks/")) {
        assert.ok(wire, "network IO before journal subject"); return wire.input.client.buffered(request);
      }
      if (request.path.startsWith("/v1.47/images/")) {
        assert.equal(request.path, `/v1.47/images/${encodeURIComponent(lock.imageReference)}/json`);
        return json({Id: IMAGE_CONFIG, RepoDigests: [lock.imageReference], Architecture: "amd64", Os: "linux"});
      }
      const result = await daemon.client.buffered(request);
      if (request.path.endsWith("/start") && result.statusCode === 204) {populate(); wire.attach();}
      if (/\/(stop|kill)(?:\?|$)/u.test(request.path) && result.statusCode === 204) {
        await network.dispose(); clearPopulation();
      }
      if (request.method === "DELETE" && result.statusCode === 204) {
        await network.dispose(); clearPopulation(); io.removeTree(leaf); wire.detach();
      }
      return result;
    },
    async stream(request) {
      if (!request.path.includes("/archive?path=")) {return daemon.client.stream(request);}
      const path = decodeURIComponent(request.path.split("?path=")[1]);
      assert.ok([DOCKER_CUSTODY_NODE_PATH, DOCKER_CUSTODY_BOOTSTRAP_PATH].includes(path));
      const node = path === DOCKER_CUSTODY_NODE_PATH;
      return {statusCode: 200, contentType: "application/x-tar",
        body: chunks(archive(path, node ? NODE_BYTES : BOOTSTRAP_BYTES, node ? 0o555 : 0o444))};
    },
    async hijack() {
      assert.equal(output, undefined, "one init reader");
      const input = new PassThrough(); output = new PassThrough();
      const decoder = new DockerCustodyFrameDecoder();
      input.on("data", bytes => {
        for (const message of decoder.push(bytes)) {
          messages.push(message);
          if (message.kind === "host-handshake") {
            push({kind: "init-ready", launchFingerprintSha256: message.launchFingerprintSha256,
              nonce: message.nonce, observedIdentity: message.expectedIdentity, protocol: DOCKER_CUSTODY_INIT_PROTOCOL});
          }
          protocolConsumer?.(message, push);
        }
      });
      return {input, output, async close() {closed = true; input.destroy(); output.destroy();}};
    },
  };
  return {client, io, messages, storage, lock, push,
    endProtocol() {assert.ok(output && !closed); output.end();},
    async inspect(authority, call) {assert.ok(boundEngine); return boundEngine.inspect(authority, call);},
    consumeProtocol(consumer) {assert.equal(protocolConsumer, undefined); protocolConsumer = consumer;},
    async engineIdentity(call) {
      return new NodeUnixSocketDockerEngine({client, policy}).identity(call);
    },
    openLifecycle(boundPolicy) {
      assert.equal(composed, undefined, "one residue lifecycle");
      const engine = new NodeUnixSocketDockerEngine({client, policy: boundPolicy});
      boundEngine = engine;
      composed = composeLinuxDockerResidueCustody({policy: boundPolicy, journalStorage: storage}, engine, io);
      return composed.lifecycle;
    },
    bindSubject(subject) {
      assert.equal(wire, undefined, "one journal subject");
      wire = networkFixture(subject, network.gateway, {create, policy, endpoint, info, containerId: CONTAINER});
    },
    async dispose() {
      await network.dispose();
      if (composed) {await composed.disposeResidue({signal: new AbortController().signal, deadlineEpochMs: Date.now() + 5000});}
      assert.equal(io.handles.size, 0);
    },
  };
};
