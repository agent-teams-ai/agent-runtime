// Private program executed by the retained guardian child. Its OS boundaries
// are exercised separately and joined to the Host protocol in synthetic tests.
export const GUARDIAN_SOURCE = String.raw`
const { spawn, execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { fstatSync, lstatSync, readFileSync } = require("node:fs");
const { pipeline } = require("node:stream");
let provider;
let launchReceived = false;
let startState = "pending";
const darwinAdmissionMs = Number(process.argv[1]);
const darwinCustody = Number.isSafeInteger(darwinAdmissionMs) && darwinAdmissionMs > 0;
let stopping = false;
let admissionTimer;
let shutdownTimer;
let imageTimer;
let routeLaunch;
let localStopping = false;
let gracefulStopping = false;
let exitDelivered = false;
let finalityAcknowledged = false;
const streamsDelivered = new Set();
const stopGroup = () => { try { process.kill(0, "SIGKILL"); } catch { process.exit(71); } };
const finishShutdown = () => {
  if (gracefulStopping && exitDelivered && streamsDelivered.size === 2 && finalityAcknowledged) {
    clearTimeout(shutdownTimer); stopGroup();
  }
};
const stopGracefully = () => {
  if (stopping) { return; }
  stopping = true; gracefulStopping = true;
  clearTimeout(admissionTimer); clearTimeout(imageTimer);
  shutdownTimer = setTimeout(stopGroup, 1000);
  // Pending image admission is uncertainty, but real exit/stream observations
  // still belong to this retained direct child and must reach the Host.
  if (startState === "pending") { startState = "stopped"; }
  publishStream("stdout"); publishStream("stderr");
  if (provider === undefined) { stopGroup(); return; }
  if (provider.exitCode === null && provider.signalCode === null) {
    try { provider.kill("SIGKILL"); } catch {}
  }
  finishShutdown();
};
// The retained ChildProcess is still ours when its process group changes. Do
// not make local shutdown depend on an IPC acknowledgement from a lost Host.
const stopLocally = () => {
  if (!darwinCustody || localStopping) { return; }
  stopping = true; localStopping = true; gracefulStopping = false;
  clearTimeout(shutdownTimer);
  clearTimeout(admissionTimer);
  clearTimeout(imageTimer);
  if (provider === undefined || provider.exitCode !== null || provider.signalCode !== null) {
    stopGroup(); return;
  }
  provider.once("exit", () => { clearTimeout(shutdownTimer); stopGroup(); });
  shutdownTimer = setTimeout(stopGroup, 1000);
  try { provider.kill("SIGKILL"); } catch {}
};
if (darwinCustody) {
  admissionTimer = setTimeout(stopLocally, darwinAdmissionMs);
  process.on("disconnect", stopLocally);
}
const streamReports = new Set();
const streamSettlements = new Map();
process.on("SIGTERM", () => {});
const send = (message, callback) => {
  if (darwinCustody) {
    if (!process.connected || typeof process.send !== "function") { stopLocally(); return; }
    try { process.send(message, error => { if (error) { stopLocally(); } else { callback?.(null); } }); }
    catch { stopLocally(); }
    return;
  }
  if (typeof process.send !== "function") { process.exit(70); return; }
  process.send(message, callback);
};
const startCode = code => {
  if (code === "EACCES" || code === "EPERM") { return "access-denied"; }
  if (code === "ENOENT") { return "executable-not-found"; }
  if (code === "EAGAIN" || code === "EMFILE" || code === "ENFILE" || code === "ENOMEM") { return "resource-unavailable"; }
  return "unknown-start-failure";
};
const reportStream = (stream, status, stopGroup) => {
  if (streamReports.has(stream)) { return; }
  streamReports.add(stream);
  send({ status, stream, type: "stream-final" }, error => {
    if (darwinCustody) {
      streamsDelivered.add(stream); finishShutdown();
      if (error || stopGroup) { stopLocally(); }
    } else if (error || stopGroup) { process.kill(0, "SIGKILL"); }
  });
};
const publishStream = stream => {
  if (startState === "pending" || streamReports.has(stream)) { return; }
  if (startState === "failed") {
    reportStream(stream, "complete", false);
    return;
  }
  const status = streamSettlements.get(stream);
  if (status !== undefined) { reportStream(stream, status, status === "error"); }
};
const handoff = (stream, source, destination) => {
  pipeline(source, destination, error => {
    streamSettlements.set(stream, error ? "error" : "complete");
    publishStream(stream);
  });
};
const exactCanonicalAuthority = message => {
  if (message.canonicalAuthority === undefined) { return true; }
  try {
    const executablePath = lstatSync(message.command, { bigint: true });
    const executableHeld = fstatSync(message.canonicalAuthority.executableDescriptor, { bigint: true });
    const workspacePath = lstatSync(message.cwd, { bigint: true });
    const workspaceHeld = fstatSync(message.canonicalAuthority.workspaceDescriptor, { bigint: true });
    const executableSha256 = createHash("sha256").update(readFileSync(message.command)).digest("hex");
    return executablePath.isFile() && workspacePath.isDirectory() && workspaceHeld.isDirectory() &&
      String(executablePath.dev) === message.canonicalAuthority.executableDev &&
      String(executablePath.ino) === message.canonicalAuthority.executableIno &&
      executableSha256 === message.canonicalAuthority.executableSha256 &&
      executablePath.dev === executableHeld.dev && executablePath.ino === executableHeld.ino &&
      String(workspacePath.dev) === message.canonicalAuthority.workspaceDev &&
      String(workspacePath.ino) === message.canonicalAuthority.workspaceIno &&
      workspacePath.dev === workspaceHeld.dev && workspacePath.ino === workspaceHeld.ino;
  } catch { return false; }
};
const exactPin = pin => {
  const stats = lstatSync(pin.path, {bigint: true});
  return stats.isFile() && !stats.isSymbolicLink() && stats.nlink === 1n &&
    (stats.uid === 0n || stats.uid === BigInt(process.getuid())) && String(stats.uid) === pin.uid &&
    (stats.mode & 0o022n) === 0n && (stats.mode & 0o111n) !== 0n &&
    String(stats.dev) === pin.dev && String(stats.ino) === pin.ino &&
    createHash("sha256").update(readFileSync(pin.path)).digest("hex") === pin.sha256;
};
const exactRoute = message => {
  if (message.darwinRoute === undefined) {return true;}
  const route = message.darwinRoute;
  try {
    return darwinCustody && message.canonicalAuthority !== undefined &&
      route.provider.path === message.command && route.provider.dev === message.canonicalAuthority.executableDev &&
      route.provider.ino === message.canonicalAuthority.executableIno &&
      route.provider.sha256 === message.canonicalAuthority.executableSha256 &&
      route.launcher.path === "/usr/bin/sandbox-exec" &&
      createHash("sha256").update(route.profile).digest("hex") === route.profileSha256 &&
      [route.provider, route.launcher, route.observer].every(exactPin);
  } catch {return false;}
};
const observeImage = previous => {
  if (stopping || !provider || provider.exitCode !== null || provider.signalCode !== null) {stopLocally(); return;}
  try {
    if (!exactPin(routeLaunch.observer) || !exactPin(routeLaunch.provider)) {stopLocally(); return;}
    const text = execFileSync(routeLaunch.observer.path, [String(provider.pid), routeLaunch.provider.path], {
      encoding: "utf8", timeout: 250, maxBuffer: 2048, env: {PATH: "/usr/bin:/bin"}, stdio: ["ignore", "pipe", "ignore"],
    });
    const image = JSON.parse(text);
    if (image.protocol !== "ae-darwin-owned-image/v1" || image.pid !== provider.pid || image.ppid !== process.pid ||
        image.pgid !== process.pid || image.dev !== routeLaunch.provider.dev || image.ino !== routeLaunch.provider.ino ||
        !/^[1-9][0-9]{0,19}$/.test(image.birthSeconds) || !/^[0-9]{1,6}$/.test(image.birthMicros)) {
      stopLocally(); return;
    }
    if (previous === undefined) {imageTimer = setTimeout(() => observeImage(image), 1); return;}
    if (JSON.stringify(previous) !== JSON.stringify(image)) {stopLocally(); return;}
    if (stopping || provider.exitCode !== null || provider.signalCode !== null) {stopLocally(); return;}
    clearTimeout(admissionTimer); startState = "started";
    send({type: "started", pid: provider.pid, darwinImage: image});
    publishStream("stdout"); publishStream("stderr");
  } catch {
    // Read-only observation retry while wrapper exec is pending, bounded by the
    // independent admission timer. Never relaunch/replay a provider effect.
    imageTimer = setTimeout(() => observeImage(previous), 10);
  }
};
const signalGroup = signal => {
  if (darwinCustody && signal === "SIGKILL") {
    send({ type: "signal-issued", signal });
    stopLocally();
    return;
  }
  if (signal === "SIGTERM") {
    process.kill(0, signal);
    send({ type: "signal-issued", signal });
    return;
  }
  send({ type: "signal-issued", signal }, error => {
    if (error) { process.exit(71); return; }
    process.kill(0, "SIGKILL");
  });
};
process.on("message", message => {
  if (message === null || typeof message !== "object") { return; }
  if (darwinCustody && message.type === "finality-ack") {
    finalityAcknowledged = true; finishShutdown(); return;
  }
  if (darwinCustody && message.type === "shutdown") { stopGracefully(); return; }
  if (stopping) { return; }
  if (message.type === "provider-signal" && message.signal === "SIGKILL") {
    let sent = false;
    try {
      sent = provider !== undefined && provider.exitCode === null && provider.signalCode === null && provider.kill(message.signal);
    } catch {}
    send({ sent, signal: message.signal, type: "provider-signal-issued" });
    return;
  }
  if (message.type === "signal" && (message.signal === "SIGTERM" || message.signal === "SIGKILL")) {
    signalGroup(message.signal);
    return;
  }
  if (message.type !== "launch" || launchReceived) { return; }
  launchReceived = true;
  if (!exactCanonicalAuthority(message) || !exactRoute(message)) {
    startState = "failed";
    send({ type: "start-error" });
    publishStream("stdout");
    publishStream("stderr");
    return;
  }
  // Cooperative Darwin uses canonical path authority; proof descriptors stay
  // with the guardian and are not forwarded into the provider spawn.
  const providerInheritedDescriptors = message.canonicalAuthority === undefined
    ? message.inheritedDescriptors
    : [];
  const maximumDescriptor = Math.max(2, ...providerInheritedDescriptors);
  const stdio = Array.from({ length: maximumDescriptor + 1 }, () => "ignore");
  stdio[0] = "pipe";
  stdio[1] = "pipe";
  stdio[2] = "pipe";
  for (const descriptor of providerInheritedDescriptors) { stdio[descriptor] = descriptor; }
  try {
    routeLaunch = message.darwinRoute;
    provider = spawn(routeLaunch === undefined ? message.command : routeLaunch.launcher.path,
      routeLaunch === undefined ? message.arguments : ["-p", routeLaunch.profile, message.command, ...message.arguments], {
      cwd: message.cwd,
      detached: false,
      env: message.environment,
      shell: false,
      stdio,
      windowsHide: true,
    });
  } catch {
    startState = "failed";
    send({ type: "start-error" });
    publishStream("stdout");
    publishStream("stderr");
    return;
  }
  process.stdin.pipe(provider.stdin);
  handoff("stdout", provider.stdout, process.stdout);
  handoff("stderr", provider.stderr, process.stderr);
  provider.once("spawn", () => {
    if (stopping) { try { provider.kill("SIGKILL"); } catch {} return; }
    if (routeLaunch !== undefined) {observeImage(); return;}
    clearTimeout(admissionTimer);
    startState = "started";
    send({ type: "started", pid: provider.pid });
    publishStream("stdout");
    publishStream("stderr");
  });
  provider.once("error", error => {
    if (startState === "pending") {
      startState = "failed";
      send({ code: startCode(error.code), type: "start-error" });
      publishStream("stdout");
      publishStream("stderr");
      return;
    }
    streamSettlements.set("stdout", "error");
    streamSettlements.set("stderr", "error");
    publishStream("stdout");
    publishStream("stderr");
  });
  provider.once("exit", (code, signal) => {
    send({ code, signal, type: "provider-exit" }, () => { exitDelivered = true; finishShutdown(); });
  });
});
send({ type: "ready" });
`;
