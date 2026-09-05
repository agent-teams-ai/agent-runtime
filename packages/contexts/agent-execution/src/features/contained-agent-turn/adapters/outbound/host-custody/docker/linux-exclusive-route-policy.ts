import { createHash } from "node:crypto";

/** Exact Linux x64 candidate policy. It is an enforcement recipe, never authority. */
export const LINUX_EXCLUSIVE_ROUTE_POLICY_REVISION = "linux-x64-exclusive-http-route/v2";

// No namespace creation/entry, mounts, ptrace, BPF, io_uring, raw sockets,
// pidfd_getfd, keyrings, or alternate syscall architecture. Descendants inherit
// both this seccomp filter and the network namespace's default-drop rules.
const ORDINARY_SYSCALLS = [
  "accept", "accept4", "access", "arch_prctl", "bind", "brk", "chdir", "chmod", "clock_getres",
  "clock_gettime", "clock_nanosleep", "close", "close_range", "connect", "copy_file_range",
  "dup", "dup2", "dup3", "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_pwait2",
  "epoll_wait", "eventfd", "eventfd2", "execve", "execveat", "exit", "exit_group", "faccessat",
  "faccessat2", "fadvise64", "fallocate", "fchdir", "fchmod", "fchmodat", "fcntl", "fdatasync",
  "flock", "fork", "fstat", "fstatfs", "fsync", "ftruncate", "futex", "futex_waitv", "getcwd",
  "getdents", "getdents64", "getegid", "geteuid", "getgid", "getgroups", "getpeername", "getpgid",
  "getpgrp", "getpid", "getppid", "getrandom", "getresgid", "getresuid", "getrlimit", "getsid",
  "getsockname", "getsockopt", "gettid", "gettimeofday", "getuid", "ioctl", "kill", "link",
  "linkat", "listen", "lseek", "lstat", "madvise", "membarrier", "mincore", "mkdir", "mkdirat",
  "mmap", "mprotect", "mremap", "msync", "munmap", "nanosleep", "newfstatat", "open", "openat",
  "openat2", "pause", "pipe", "pipe2", "poll", "ppoll", "prctl", "pread64", "preadv", "preadv2",
  "prlimit64", "pselect6", "pwrite64", "pwritev", "pwritev2", "read", "readlink", "readlinkat",
  "readv", "recvfrom", "recvmmsg", "recvmsg", "rename", "renameat", "renameat2", "restart_syscall",
  "rmdir", "rseq", "rt_sigaction", "rt_sigpending", "rt_sigprocmask", "rt_sigreturn", "rt_sigsuspend",
  "rt_sigtimedwait", "sched_getaffinity", "sched_getparam", "sched_getscheduler", "sched_yield",
  "select", "sendfile", "sendmmsg", "sendmsg", "sendto", "set_robust_list", "set_tid_address",
  "setpgid", "setpriority", "setrlimit", "setsid", "setsockopt", "shutdown", "sigaltstack",
  "stat", "statfs", "statx", "symlink", "symlinkat", "sysinfo", "tgkill",
  "time", "timer_create", "timer_delete", "timer_gettime", "timer_settime", "timerfd_create",
  "timerfd_gettime", "timerfd_settime", "times", "truncate", "umask", "uname", "unlink", "unlinkat",
  "utimensat", "vfork", "wait4", "waitid", "write", "writev",
] as const;

export const linuxExclusiveRouteSeccomp = (): Readonly<{json: string; sha256: string}> => {
  const json = JSON.stringify({defaultAction: "SCMP_ACT_ERRNO", defaultErrnoRet: 1,
    architectures: ["SCMP_ARCH_X86_64"], syscalls: [
      {names: ORDINARY_SYSCALLS, action: "SCMP_ACT_ALLOW"},
      {names: ["clone"], action: "SCMP_ACT_ALLOW", args: [
        {index: 0, value: 0x7e020080, valueTwo: 0, op: "SCMP_CMP_MASKED_EQ"},
      ]},
      // clone3's argument pointer cannot be filtered; ENOSYS enables libc's clone fallback.
      {names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38},
      // Only already-connected local stream pairs for child stdio. In particular,
      // AF_TIPC and reconnectable Unix datagram pairs must not create another route.
      {names: ["socketpair"], action: "SCMP_ACT_ALLOW", args: [
        {index: 0, value: 1, op: "SCMP_CMP_EQ"},
        {index: 1, value: 15, valueTwo: 1, op: "SCMP_CMP_MASKED_EQ"},
        {index: 2, value: 0, op: "SCMP_CMP_EQ"},
      ]},
      {names: ["socket"], action: "SCMP_ACT_ALLOW", args: [
        {index: 0, value: 2, op: "SCMP_CMP_EQ"}, // AF_INET only
        {index: 1, value: 15, valueTwo: 1, op: "SCMP_CMP_MASKED_EQ"}, // SOCK_STREAM
        {index: 2, value: 0, op: "SCMP_CMP_EQ"},
      ]},
      {names: ["socket"], action: "SCMP_ACT_ALLOW", args: [
        {index: 0, value: 2, op: "SCMP_CMP_EQ"},
        {index: 1, value: 15, valueTwo: 1, op: "SCMP_CMP_MASKED_EQ"},
        {index: 2, value: 6, op: "SCMP_CMP_EQ"}, // IPPROTO_TCP
      ]},
    ]});
  return Object.freeze({json, sha256: createHash("sha256").update(json).digest("hex")});
};

export interface LinuxExclusiveRouteEndpoint {
  readonly address: string;
  readonly port: number;
}

const match = (left: unknown, right: unknown) => ({match: {op: "==", left, right}});
const payload = (protocol: string, field: string) => ({payload: {protocol, field}});
// Retain V1's exclusive table identity so old deny tables cannot be bypassed.
// V1 was never qualified; it is cleanup-only, never a live compatibility recipe.
export const LINUX_EXCLUSIVE_ROUTE_TABLE = "ar_provider_route_v1";
const table = LINUX_EXCLUSIVE_ROUTE_TABLE;

/** nft JSON timeout/expires are quantized SECONDS, not milliseconds.
 * Reserve a whole second for countdown/tick rounding and a further second for
 * install acknowledgement. Require two seconds of membership: a zero-second
 * displayed expires cannot prove liveness. Thus preparation needs >= 4000 ms.
 * This is a fixed, one-shot recipe; packet traffic and readback never renew it.
 */
export const LINUX_ROUTE_ROUNDING_MS = 1_000;
export const LINUX_ROUTE_ACK_MS = 1_000;
export const LINUX_ROUTE_MIN_LIFETIME_MS = 4_000;
export const LINUX_ROUTE_MAX_LIFETIME_MS = 120_000;
const validTimeout = (seconds: number): boolean =>
  Number.isSafeInteger(seconds) && seconds >= 2 && seconds <= 118;

export const validateLinuxExclusiveRouteEndpoint = (endpoint: LinuxExclusiveRouteEndpoint): void => {
  const octets = typeof endpoint.address === "string" ? endpoint.address.split(".") : [];
  if (octets.length !== 4 || octets.some(octet => !/^(?:0|[1-9][0-9]{0,2})$/u.test(octet) || Number(octet) > 255) ||
      !/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/u.test(endpoint.address) ||
      !Number.isSafeInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535) {
    throw new TypeError("exclusive broker endpoint must be exact private IPv4 and unprivileged TCP port");
  }
};

/** Applied in the provider's private network namespace before provider exec. */
export const linuxExclusiveRouteRules = (endpoint: LinuxExclusiveRouteEndpoint, timeoutSeconds: number | false): readonly object[] => {
  validateLinuxExclusiveRouteEndpoint(endpoint);
  if (timeoutSeconds !== false && !validTimeout(timeoutSeconds)) {throw new TypeError("unsupported kernel route timeout");}
  const common = {family: "inet", table};
  return [
    {table: {family: "inet", name: table}},
    ...(timeoutSeconds === false ? [] : [{set: {...common, name: "broker", type: "ipv4_addr",
      flags: ["timeout"], elem: [{elem: {val: endpoint.address, timeout: timeoutSeconds}}]}}]),
    ...["input", "output", "forward"].map(name => ({chain: {...common, name, type: "filter",
      hook: name, prio: 300, policy: "drop"}})),
    ...(timeoutSeconds !== false ? [
      {rule: {...common, chain: "output", expr: [
        match(payload("ip", "daddr"), "@broker"), match(payload("tcp", "dport"), endpoint.port),
        {accept: null},
      ]}},
      {rule: {...common, chain: "input", expr: [
        match(payload("ip", "saddr"), "@broker"), match(payload("tcp", "sport"), endpoint.port),
        match({ct: {key: "state"}}, "established"), {accept: null},
      ]}},
    ] : []),
  ];
};

export const linuxExclusiveRouteTransaction = (endpoint: LinuxExclusiveRouteEndpoint, replace: boolean,
  timeoutSeconds: number | false): string => JSON.stringify({nftables: [
    ...(replace ? [{delete: {table: {family: "inet", name: table}}}] : []),
    // nft's add is idempotent for tables. Only create excludes a previous
    // owner's deny-only table, atomically with the rest of fresh admission.
    ...linuxExclusiveRouteRules(endpoint, timeoutSeconds).map(value => "table" in value ? {create: value} : {add: value}),
  ]});

type PolicyChain = {definition: object; rules: object[]};
const chainIdentity = (body: Record<string, unknown>, name: unknown): string =>
  canonical([body.family, body.table, name]);

const policyEntry = (entry: unknown): {kind: string; body: Record<string, unknown>} | undefined => {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {return undefined;}
  const keys = Object.keys(entry);
  if (keys.length !== 1) {return undefined;}
  const kind = keys[0]!; const value = Reflect.get(entry, kind) as Record<string, unknown>;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return undefined;}
  if (kind === "metainfo") {
    if (value.json_schema_version !== 1 || typeof value.version !== "string" ||
        typeof value.release_name !== "string" || Object.keys(value).length !== 3) {return undefined;}
  } else if (value.handle !== undefined && (!Number.isSafeInteger(value.handle) || Number(value.handle) < 1)) {return undefined;}
  const {handle: _handle, ...body} = value;
  return {kind, body};
};

export interface LinuxExclusiveRouteReadWindow {
  readonly timeoutSeconds: number;
  readonly beforeMs: number;
  readonly afterMs: number;
  /** Original install acknowledgement + exact timeout + rounding margin.
   * Must already be bounded by the original operation lease, never reset. */
  readonly cutoffMs: number;
}

const readMembership = (entries: readonly unknown[], timeoutSeconds: number | false):
  {cleaned: unknown[]; expires: number} | undefined => {
  let expires = 0;
  const cleaned: unknown[] = [];
  for (const entry of entries) {
    const parsed = policyEntry(entry);
    if (parsed === undefined) {return undefined;}
    if (parsed.kind !== "set") {cleaned.push(entry); continue;}
    if (timeoutSeconds === false || !Array.isArray(parsed.body.elem) || parsed.body.elem.length !== 1) {return undefined;}
    const wrapper = parsed.body.elem[0];
    if (wrapper === null || typeof wrapper !== "object" || Object.keys(wrapper).length !== 1 ||
        wrapper.elem === null || typeof wrapper.elem !== "object" || Array.isArray(wrapper.elem)) {return undefined;}
    const {expires: countdown, ...element} = wrapper.elem;
    if (!Number.isSafeInteger(countdown) || countdown < 1 || countdown > timeoutSeconds) {return undefined;}
    expires = countdown;
    cleaned.push({set: {...parsed.body, elem: [{elem: element}]}});
  }
  return {cleaned, expires};
};

/** Only native handles/metainfo and a bounded countdown are non-policy data.
 * Group chain identities, preserving every rule and expression's order. The
 * result is a conservative live-until lower bound, not a renewal or receipt.
 * A listing sampled inside [before, after] has remaining time in [E,E+1) s.
 * Reject zero E and reads crossing before+E: the element may already be gone.
 */
export const linuxExclusiveRouteReadback = (observed: unknown, endpoint: LinuxExclusiveRouteEndpoint,
  permit: LinuxExclusiveRouteReadWindow | false): number | undefined => {
  if (typeof observed !== "object" || observed === null || Array.isArray(observed) ||
      Object.keys(observed).length !== 1 || !Array.isArray(Reflect.get(observed, "nftables"))) {return undefined;}
  const entries = (observed as {nftables: unknown[]}).nftables;
  if (entries.length > 16) {return undefined;}
  const membership = readMembership(entries, permit === false ? false : permit.timeoutSeconds);
  if (membership === undefined) {return undefined;}
  const {cleaned, expires} = membership;
  const actual = normalizePolicy(cleaned);
  if (actual === undefined || actual !== normalizePolicy(linuxExclusiveRouteRules(endpoint,
    permit === false ? false : permit.timeoutSeconds))) {return undefined;}
  if (permit === false) {return 0;}
  const {beforeMs, afterMs, cutoffMs, timeoutSeconds} = permit;
  if (![beforeMs, afterMs, cutoffMs].every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) ||
      afterMs < beforeMs || afterMs >= cutoffMs) {return undefined;}
  const lower = beforeMs + expires * 1_000;
  // Never interpret integer expires as exact milliseconds. The listing may
  // have been sampled at the END of a blocking read; use after+(E+1) seconds.
  // The original exact-timeout ceiling includes one rounding second. Reject
  // inconsistent/stale countdowns instead of clamping away excess authority.
  const upper = afterMs + (expires + 1) * 1_000;
  if (upper > cutoffMs || afterMs >= lower || upper <= afterMs || !validTimeout(timeoutSeconds)) {return undefined;}
  return Math.min(lower, cutoffMs);
};

const normalizePolicy = (entries: readonly unknown[]): string | undefined => {
  if (entries.length > 16) {return undefined;}
  let definition: object | undefined; let membership: object | undefined; let metainfo = false;
  const chains = new Map<string, PolicyChain>(); const rules: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const parsed = policyEntry(entry);
    if (parsed === undefined) {return undefined;}
    const {kind, body} = parsed;
    if (kind === "metainfo") {
      if (metainfo || entry !== entries[0]) {return undefined;}
      metainfo = true; continue;
    }
    if (kind === "table") {
      if (definition !== undefined) {return undefined;} definition = body;
    } else if (kind === "set") {
      if (membership !== undefined) {return undefined;} membership = body;
    } else if (kind === "chain") {
      const identity = chainIdentity(body, body.name);
      if (chains.has(identity)) {return undefined;}
      chains.set(identity, {definition: body, rules: []});
    } else if (kind === "rule") {rules.push(body);} else {return undefined;}
  }
  if (definition === undefined) {return undefined;}
  for (const rule of rules) {
    const chain = chains.get(chainIdentity(rule, rule.chain));
    if (chain === undefined) {return undefined;}
    chain.rules.push(rule);
  }
  return canonical({table: definition, membership: membership ?? null, chains: [...chains.entries()].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)});
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
