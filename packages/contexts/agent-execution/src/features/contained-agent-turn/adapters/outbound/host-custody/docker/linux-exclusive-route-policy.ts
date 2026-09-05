import { createHash } from "node:crypto";

/** Exact Linux x64 candidate policy. It is an enforcement recipe, never authority. */
export const LINUX_EXCLUSIVE_ROUTE_POLICY_REVISION = "linux-x64-exclusive-http-route/v1";

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
const table = "ar_provider_route_v1";

export const validateLinuxExclusiveRouteEndpoint = (endpoint: LinuxExclusiveRouteEndpoint): void => {
  const octets = typeof endpoint.address === "string" ? endpoint.address.split(".") : [];
  if (octets.length !== 4 || octets.some(octet => !/^(?:0|[1-9][0-9]{0,2})$/u.test(octet) || Number(octet) > 255) ||
      !/^(?:10\.|172\.(?:1[6-9]|2[0-9]|3[01])\.|192\.168\.)/u.test(endpoint.address) ||
      !Number.isSafeInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535) {
    throw new TypeError("exclusive broker endpoint must be exact private IPv4 and unprivileged TCP port");
  }
};

/** Applied in the provider's private network namespace before provider exec. */
export const linuxExclusiveRouteRules = (endpoint: LinuxExclusiveRouteEndpoint, permit: boolean): readonly object[] => {
  validateLinuxExclusiveRouteEndpoint(endpoint);
  const common = {family: "inet", table};
  return [
    {table: {family: "inet", name: table}},
    ...["input", "output", "forward"].map(name => ({chain: {...common, name, type: "filter",
      hook: name, prio: 300, policy: "drop"}})),
    ...(permit ? [
      {rule: {...common, chain: "output", expr: [
        match({meta: {key: "nfproto"}}, "ipv4"), match({meta: {key: "l4proto"}}, "tcp"),
        match(payload("ip", "daddr"), endpoint.address), match(payload("tcp", "dport"), endpoint.port),
        {accept: null},
      ]}},
      {rule: {...common, chain: "input", expr: [
        match({meta: {key: "nfproto"}}, "ipv4"), match({meta: {key: "l4proto"}}, "tcp"),
        match(payload("ip", "saddr"), endpoint.address), match(payload("tcp", "sport"), endpoint.port),
        match({ct: {key: "state"}}, "established"), {accept: null},
      ]}},
    ] : []),
  ];
};

export const linuxExclusiveRouteTransaction = (endpoint: LinuxExclusiveRouteEndpoint, replace: boolean,
  permit: boolean): string => JSON.stringify({nftables: [
    ...(replace ? [{delete: {table: {family: "inet", name: table}}}] : []),
    // nft's add is idempotent for tables. Only create excludes a previous
    // owner's deny-only table, atomically with the rest of fresh admission.
    ...linuxExclusiveRouteRules(endpoint, permit).map(value => "table" in value ? {create: value} : {add: value}),
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

/** Table listings group rules with chains, unlike transaction command order.
 * Compare identities independently of chain order, retaining rule/expr order.
 * Only nft's object handles and listing metadata are non-policy fields.
 */
export const linuxExclusiveRouteRulesMatch = (observed: unknown, endpoint: LinuxExclusiveRouteEndpoint,
  permit: boolean): boolean => {
  if (typeof observed !== "object" || observed === null || Array.isArray(observed) ||
      Object.keys(observed).length !== 1 || !Array.isArray(Reflect.get(observed, "nftables"))) {return false;}
  const actual = normalizePolicy((observed as {nftables: unknown[]}).nftables);
  return actual !== undefined && actual === normalizePolicy(linuxExclusiveRouteRules(endpoint, permit));
};

const normalizePolicy = (entries: readonly unknown[]): string | undefined => {
  if (entries.length > 16) {return undefined;}
  let definition: object | undefined; let metainfo = false;
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
  return canonical({table: definition, chains: [...chains.entries()].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)});
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {return `[${value.map(canonical).join(",")}]`;}
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
