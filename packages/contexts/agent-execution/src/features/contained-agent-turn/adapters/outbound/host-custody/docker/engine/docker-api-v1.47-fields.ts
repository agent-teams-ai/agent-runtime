export const INFO_FIELDS = Object.freeze([
  "Architecture", "BridgeNfIp6tables", "BridgeNfIptables", "CDISpecDirs", "CPUSet", "CPUShares",
  "CgroupDriver", "CgroupVersion", "ClusterAdvertise", "ClusterStore", "Containerd", "ContainerdCommit",
  "Containers", "ContainersPaused", "ContainersRunning", "ContainersStopped", "CpuCfsPeriod", "CpuCfsQuota",
  "Debug", "DefaultAddressPools", "DefaultRuntime", "DockerRootDir", "Driver", "DriverStatus",
  "ExperimentalBuild", "FirewallBackend", "GenericResources", "HttpProxy", "HttpsProxy", "ID", "IPv4Forwarding",
  "Images", "IndexServerAddress", "InitBinary", "InitCommit", "Isolation", "KernelMemory", "KernelMemoryTCP",
  "KernelVersion", "Labels", "LiveRestoreEnabled", "LoggingDriver", "MemTotal", "MemoryLimit", "NCPU", "NEventsListener",
  "NFd", "NGoroutines", "Name", "NoProxy", "OSType", "OSVersion", "OomKillDisable", "OperatingSystem",
  "PidsLimit", "Plugins", "ProductLicense", "RegistryConfig", "RuncCommit", "Runtimes", "SecurityOptions",
  "ServerVersion", "SwapLimit", "Swarm", "SystemStatus", "SystemTime", "Warnings",
]);

export const INSPECT_FIELDS = Object.freeze([
  "AppArmorProfile", "Args", "Config", "Created", "Driver", "ExecIDs", "GraphDriver", "HostConfig",
  "HostnamePath", "HostsPath", "Id", "Image", "ImageManifestDescriptor", "LogPath", "MountLabel", "Mounts",
  "Name", "NetworkSettings", "Node", "Path", "Platform", "ProcessLabel", "ResolvConfPath", "RestartCount", "SizeRootFs",
  "SizeRw", "State",
]);

export const CONFIG_FIELDS = Object.freeze([
  "ArgsEscaped", "AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Domainname", "Entrypoint", "Env",
  "ExposedPorts", "Healthcheck", "Hostname", "Image", "Labels", "MacAddress", "NetworkDisabled", "OnBuild",
  "OpenStdin", "Shell", "StdinOnce", "StopSignal", "StopTimeout", "Tty", "User", "Volumes", "WorkingDir",
]);

export const HOST_CONFIG_FIELDS = Object.freeze([
  "Annotations", "AutoRemove", "Binds", "BlkioDeviceReadBps", "BlkioDeviceReadIOps", "BlkioDeviceWriteBps",
  "BlkioDeviceWriteIOps", "BlkioWeight", "BlkioWeightDevice", "CapAdd", "CapDrop", "Cgroup", "CgroupParent",
  "CgroupnsMode", "ConsoleSize", "ContainerIDFile", "CpuCount", "CpuPercent", "CpuPeriod", "CpuQuota",
  "CpuRealtimePeriod", "CpuRealtimeRuntime", "CpuShares", "CpusetCpus", "CpusetMems", "DeviceCgroupRules",
  "DeviceRequests", "Devices", "Dns", "DnsOptions", "DnsSearch", "ExtraHosts", "GroupAdd", "IOMaximumBandwidth",
  "IOMaximumIOps", "Init", "IpcMode", "Isolation", "Links", "LogConfig", "MaskedPaths", "Memory",
  "MemoryReservation", "MemorySwap", "MemorySwappiness", "Mounts", "NanoCpus", "NetworkMode", "OomKillDisable",
  "OomScoreAdj", "PidMode", "PidsLimit", "PortBindings", "Privileged", "PublishAllPorts", "ReadonlyPaths",
  "ReadonlyRootfs", "RestartPolicy", "Runtime", "SecurityOpt", "ShmSize", "StorageOpt", "Sysctls", "Tmpfs",
  "UTSMode", "Ulimits", "UsernsMode", "VolumeDriver", "VolumesFrom",
]);

export const CONFIGURED_MOUNT_FIELDS = Object.freeze([
  "BindOptions", "Consistency", "ReadOnly", "Source", "Target", "TmpfsOptions", "Type", "VolumeOptions",
]);

export const BIND_OPTIONS_FIELDS = Object.freeze([
  "CreateMountpoint", "NonRecursive", "Propagation", "ReadOnlyForceRecursive", "ReadOnlyNonRecursive",
]);

export const OBSERVED_MOUNT_FIELDS = Object.freeze([
  "Destination", "Driver", "Mode", "Name", "Propagation", "RW", "Source", "Type",
]);

export const CREATE_CONFIG_FIELDS = Object.freeze([
  "AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env", "Image", "Labels",
  "NetworkDisabled", "OpenStdin", "StdinOnce", "StopSignal", "Tty", "User", "WorkingDir",
]);

export const CREATE_HOST_FIELDS = Object.freeze([
  "AutoRemove", "CapDrop", "CgroupParent", "CgroupnsMode", "CpuPeriod", "Init", "IpcMode", "Memory",
  "MemorySwap", "Mounts", "NanoCpus", "NetworkMode", "OomKillDisable", "PidMode", "PidsLimit", "Privileged",
  "ReadonlyRootfs", "RestartPolicy", "SecurityOpt", "StorageOpt", "Tmpfs",
]);
