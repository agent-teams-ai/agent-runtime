#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import resource
import shutil
import time
import uuid
from datetime import timedelta
from pathlib import Path

from opensandbox import Sandbox
from opensandbox.config import ConnectionConfig
from opensandbox.exceptions import SandboxException
from opensandbox.manager import SandboxManager
from opensandbox.models.sandboxes import Host, NetworkPolicy, SandboxFilter, Volume

SPIKE_RUN_ID = os.environ.get("SPIKE_RUN_ID", "sandbox-hosting-v1")
MIN_AVAILABLE_MEMORY_MB = int(os.environ.get("MIN_AVAILABLE_MEMORY_MB", "3072"))
MIN_FREE_DISK_GB = int(os.environ.get("MIN_FREE_DISK_GB", "20"))
MAX_CPU_PSI_AVG10 = float(os.environ.get("MAX_CPU_PSI_AVG10", "80"))
MAX_MEMORY_PSI_AVG10 = float(os.environ.get("MAX_MEMORY_PSI_AVG10", "10"))
MAX_IO_PSI_AVG10 = float(os.environ.get("MAX_IO_PSI_AVG10", "20"))


def evidence_root() -> Path:
    root = Path(os.environ.get("EVIDENCE_DIR", "artifacts/sandbox-hosting-spike"))
    root.mkdir(parents=True, exist_ok=True)
    return root


def evidence_path(name: str) -> Path:
    return evidence_root() / name


def append_jsonl(path: Path, payload: dict[str, object]) -> None:
    with path.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, sort_keys=True) + "\n")


def process_rss_kb() -> int:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


def available_memory_mb() -> int:
    for line in Path("/proc/meminfo").read_text(encoding="utf-8").splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) // 1024
    raise RuntimeError("MemAvailable is unavailable")


def free_disk_gb() -> int:
    stat = os.statvfs(evidence_root())
    return int(stat.f_bavail * stat.f_frsize / 1024 / 1024 / 1024)


def psi_avg10(resource_name: str) -> float:
    pressure = Path(f"/proc/pressure/{resource_name}").read_text(encoding="utf-8")
    some = next(line for line in pressure.splitlines() if line.startswith("some "))
    return float(
        next(
            part.split("=", 1)[1] for part in some.split() if part.startswith("avg10=")
        )
    )


def host_snapshot() -> dict[str, object]:
    return {
        "availableMemoryMb": available_memory_mb(),
        "freeDiskGb": free_disk_gb(),
        "cpuPsiAvg10": psi_avg10("cpu"),
        "memoryPsiAvg10": psi_avg10("memory"),
        "ioPsiAvg10": psi_avg10("io"),
    }


def guard_host() -> dict[str, object]:
    snapshot = host_snapshot()
    failures = []
    if snapshot["availableMemoryMb"] < MIN_AVAILABLE_MEMORY_MB:
        failures.append("available memory")
    if snapshot["freeDiskGb"] < MIN_FREE_DISK_GB:
        failures.append("free disk")
    if snapshot["cpuPsiAvg10"] > MAX_CPU_PSI_AVG10:
        failures.append("CPU PSI")
    if snapshot["memoryPsiAvg10"] > MAX_MEMORY_PSI_AVG10:
        failures.append("memory PSI")
    if snapshot["ioPsiAvg10"] > MAX_IO_PSI_AVG10:
        failures.append("IO PSI")
    if failures:
        raise RuntimeError(f"host guard rejected run: {', '.join(failures)}")
    return snapshot


def connection() -> ConnectionConfig:
    return ConnectionConfig(
        domain=os.environ.get("OPEN_SANDBOX_DOMAIN", "127.0.0.1:18080"),
        request_timeout=timedelta(seconds=30),
    )


async def manager_for_spike() -> SandboxManager:
    return await SandboxManager.create(connection())


async def list_spike_sandboxes(
    *, extra_metadata: dict[str, str] | None = None
) -> list[object]:
    metadata = {"spike_run": SPIKE_RUN_ID, **(extra_metadata or {})}
    manager = await manager_for_spike()
    found: list[object] = []
    try:
        page = 1
        while True:
            result = await manager.list_sandbox_infos(
                SandboxFilter(metadata=metadata, page=page, page_size=100)
            )
            found.extend(result.sandbox_infos)
            if not result.pagination.has_next_page:
                break
            page += 1
        return found
    finally:
        await manager.close()


async def cleanup_spike_sandboxes() -> None:
    manager = await manager_for_spike()
    try:
        page = await manager.list_sandbox_infos(
            SandboxFilter(metadata={"spike_run": SPIKE_RUN_ID}, page=1, page_size=100)
        )
        infos = list(page.sandbox_infos)
        while page.pagination.has_next_page:
            page = await manager.list_sandbox_infos(
                SandboxFilter(
                    metadata={"spike_run": SPIKE_RUN_ID},
                    page=page.pagination.page + 1,
                    page_size=100,
                )
            )
            infos.extend(page.sandbox_infos)
        await asyncio.gather(
            *(manager.kill_sandbox(info.id) for info in infos), return_exceptions=True
        )
    finally:
        await manager.close()


async def assert_no_spike_sandboxes() -> None:
    remaining = await list_spike_sandboxes()
    if remaining:
        raise RuntimeError(f"{len(remaining)} spike-owned sandboxes remain")


async def create_sandbox(
    index: int,
    *,
    scenario: str,
    operation_id: str | None = None,
    generation: int = 1,
    deny_egress: bool = False,
    volumes: list[Volume] | None = None,
) -> Sandbox:
    policy = NetworkPolicy(defaultAction="deny", egress=[]) if deny_egress else None
    return await Sandbox.create(
        os.environ.get("OPEN_SANDBOX_IMAGE", "alpine:3.22.1"),
        connection_config=connection(),
        timeout=timedelta(minutes=10),
        ready_timeout=timedelta(seconds=45),
        resource={"cpu": "0.03", "memory": "32Mi"},
        metadata={
            "spike_run": SPIKE_RUN_ID,
            "scenario": scenario,
            "operation_id": operation_id or f"{scenario}-{uuid.uuid4()}",
            "generation": str(generation),
            "index": str(index),
        },
        network_policy=policy,
        entrypoint=["sh", "-c", "while :; do sleep 60; done"],
        volumes=volumes,
    )


async def destroy_all(sandboxes: list[Sandbox]) -> None:
    await asyncio.gather(
        *(sandbox.destroy() for sandbox in sandboxes), return_exceptions=True
    )


async def run_density(args: argparse.Namespace) -> None:
    path = evidence_path(f"opensandbox-density-{args.evidence_label}.jsonl")
    path.write_text("", encoding="utf-8")
    sandboxes: list[Sandbox] = []
    await cleanup_spike_sandboxes()
    try:
        for target in range(args.step, args.max_sandboxes + 1, args.step):
            before = guard_host()
            started = time.monotonic()
            pending_indexes = list(range(len(sandboxes), target))
            for offset in range(0, len(pending_indexes), args.create_concurrency):
                batch = pending_indexes[offset : offset + args.create_concurrency]
                results = await asyncio.gather(
                    *(create_sandbox(index, scenario="density") for index in batch),
                    return_exceptions=True,
                )
                errors = [
                    result for result in results if isinstance(result, BaseException)
                ]
                sandboxes.extend(
                    result for result in results if isinstance(result, Sandbox)
                )
                if errors:
                    append_jsonl(
                        path,
                        {
                            "countBeforeFailure": len(sandboxes),
                            "createConcurrency": args.create_concurrency,
                            "failedCreates": len(errors),
                            "firstError": str(errors[0]),
                            "hostAfter": host_snapshot(),
                            "outcome": "create_failed",
                            "target": target,
                        },
                    )
                    raise RuntimeError(
                        f"{len(errors)} sandbox creates failed; first={errors[0]!r}"
                    )

            # OpenSandbox Docker metrics currently expose host-level values. Keep
            # them out of per-sandbox density totals until adapter qualification.
            metric = await sandboxes[0].get_metrics()
            append_jsonl(
                path,
                {
                    "count": target,
                    "createConcurrency": args.create_concurrency,
                    "createSeconds": round(time.monotonic() - started, 3),
                    "clientMaxRssKb": process_rss_kb(),
                    "backendMetricQualification": "host_scoped_not_per_sandbox",
                    "backendReportedMemoryUsedMiB": round(metric.memory_used_in_mib, 3),
                    "backendReportedMemoryTotalMiB": round(
                        metric.memory_total_in_mib, 3
                    ),
                    "hostBefore": before,
                    "hostAfter": host_snapshot(),
                },
            )
    finally:
        await destroy_all(sandboxes)
        await cleanup_spike_sandboxes()
        await assert_no_spike_sandboxes()


async def run_recovery(_: argparse.Namespace) -> None:
    path = evidence_path("opensandbox-recovery.jsonl")
    path.write_text("", encoding="utf-8")
    operation_id = f"create-{uuid.uuid4()}"
    await cleanup_spike_sandboxes()
    try:
        sandbox = await create_sandbox(
            1, scenario="recovery", operation_id=operation_id, generation=2
        )
        created_id = sandbox.id
        await sandbox.close()

        matches = await list_spike_sandboxes(
            extra_metadata={"operation_id": operation_id}
        )
        append_jsonl(
            path,
            {
                "scenario": "lost-create-ack",
                "outcome": "reconciled_by_operation_metadata"
                if len(matches) == 1 and matches[0].id == created_id
                else "ambiguous",
                "matches": len(matches),
            },
        )

        duplicate = await create_sandbox(
            2, scenario="recovery", operation_id=operation_id, generation=2
        )
        duplicate_matches = await list_spike_sandboxes(
            extra_metadata={"operation_id": operation_id}
        )
        append_jsonl(
            path,
            {
                "scenario": "backend-idempotency",
                "outcome": "unsupported_requires_admission_owner",
                "matchesAfterDuplicate": len(duplicate_matches),
            },
        )
        await duplicate.destroy()

        recovered = await Sandbox.connect(created_id, connection_config=connection())
        info = await recovered.get_info()
        append_jsonl(
            path,
            {
                "scenario": "client-reconnect",
                "state": str(info.status.state),
            },
        )
        await recovered.destroy()

        try:
            missing = await Sandbox.connect(created_id, connection_config=connection())
            await missing.close()
            outcome = "unexpectedly_connected"
        except SandboxException as error:
            outcome = type(error).__name__
        append_jsonl(path, {"scenario": "lost-kill-ack", "outcome": outcome})
        append_jsonl(
            path,
            {
                "scenario": "backend-generation-fence",
                "outcome": "unsupported_requires_ar_owned_fence",
                "evidence": "lifecycle methods accept sandboxId without expected generation",
            },
        )
    finally:
        await cleanup_spike_sandboxes()
        await assert_no_spike_sandboxes()


def tenant_volume(tenant: str) -> tuple[Path, Volume]:
    root = Path(os.environ["OPEN_SANDBOX_VOLUME_ROOT"])
    path = root / SPIKE_RUN_ID / tenant
    path.mkdir(parents=True, exist_ok=True)
    return path, Volume(
        name=f"{tenant}-workspace",
        host=Host(path=str(path)),
        mountPath="/workspace",
        readOnly=False,
    )


async def run_isolation(_: argparse.Namespace) -> None:
    path = evidence_path("opensandbox-isolation.jsonl")
    path.write_text("", encoding="utf-8")
    await cleanup_spike_sandboxes()
    tenant_a_path, tenant_a_volume = tenant_volume("tenant-a")
    tenant_b_path, tenant_b_volume = tenant_volume("tenant-b")
    (tenant_a_path / "owner").write_text("tenant-a-secret", encoding="utf-8")
    (tenant_b_path / "owner").write_text("tenant-b-secret", encoding="utf-8")

    sandboxes = await asyncio.gather(
        create_sandbox(
            1,
            scenario="isolation-a",
            deny_egress=True,
            volumes=[tenant_a_volume],
        ),
        create_sandbox(
            2,
            scenario="isolation-b",
            deny_egress=True,
            volumes=[tenant_b_volume],
        ),
    )
    tenant_a, tenant_b = sandboxes
    try:
        await tenant_a.commands.run(
            "mkdir -p /tmp/www; printf tenant-a-network-secret > /tmp/www/value; "
            "busybox httpd -p 8080 -h /tmp/www"
        )
        ip_execution = await tenant_a.commands.run("hostname -i | awk '{print $1}'")
        tenant_a_ip = "".join(item.text for item in ip_execution.logs.stdout).strip()
        network_execution = await tenant_b.commands.run(
            f"wget -T 2 -q -O- http://{tenant_a_ip}:8080/value >/dev/null 2>&1; printf $?"
        )
        network_exit = "".join(
            item.text for item in network_execution.logs.stdout
        ).strip()
        append_jsonl(
            path,
            {
                "scenario": "cross-tenant-network",
                "outcome": "blocked"
                if network_exit != "0"
                else "unexpectedly_reachable",
                "commandExitText": network_exit,
            },
        )

        execution = await tenant_b.commands.run(
            "env | grep -E 'AWS_|GITHUB_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY' || true"
        )
        exposed = any(item.text.strip() for item in execution.logs.stdout)
        append_jsonl(path, {"scenario": "credential-inheritance", "exposed": exposed})

        execution = await tenant_b.commands.run(
            'test "$(cat /workspace/owner)" = tenant-b-secret'
        )
        append_jsonl(
            path,
            {
                "scenario": "cross-tenant-volume",
                "outcome": "isolated" if execution.exit_code == 0 else "failed",
            },
        )

        execution = await tenant_b.commands.run(
            "wget -T 2 -q -O- http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; printf $?"
        )
        exit_text = "".join(item.text for item in execution.logs.stdout).strip()
        append_jsonl(
            path,
            {
                "scenario": "metadata-egress-deny",
                "outcome": "blocked" if exit_text != "0" else "unexpectedly_reachable",
                "commandExitText": exit_text,
            },
        )
    finally:
        await destroy_all([tenant_a, tenant_b])

    residue = await list_spike_sandboxes()
    append_jsonl(
        path,
        {
            "scenario": "destroyed-runtime-residue",
            "outcome": "no_runtime_resource" if not residue else "resource_remains",
            "externalWorkspaceStillExists": tenant_a_path.exists(),
            "note": "workspace disposal is a separate owner obligation",
        },
    )
    shutil.rmtree(tenant_a_path.parent)
    append_jsonl(
        path,
        {
            "scenario": "workspace-disposition",
            "outcome": "removed_by_explicit_owner",
        },
    )
    await cleanup_spike_sandboxes()
    await assert_no_spike_sandboxes()


async def prepare_server_restart(_: argparse.Namespace) -> None:
    path = evidence_path("opensandbox-server-restart-id.txt")
    await cleanup_spike_sandboxes()
    sandbox = await create_sandbox(
        1,
        scenario="server-restart",
        operation_id=f"server-restart-{uuid.uuid4()}",
        generation=1,
    )
    path.write_text(sandbox.id + "\n", encoding="utf-8")
    await sandbox.close()


async def verify_server_restart(_: argparse.Namespace) -> None:
    path = evidence_path("opensandbox-server-restart.jsonl")
    path.write_text("", encoding="utf-8")
    sandbox_id = (
        evidence_path("opensandbox-server-restart-id.txt")
        .read_text(encoding="utf-8")
        .strip()
    )
    try:
        sandbox = await Sandbox.connect(sandbox_id, connection_config=connection())
        execution = await sandbox.commands.run("printf recovered-after-server-restart")
        output = "".join(item.text for item in execution.logs.stdout)
        append_jsonl(
            path,
            {
                "scenario": "server-crash-recovery",
                "outcome": "reconciled"
                if output == "recovered-after-server-restart"
                else "failed",
            },
        )
        await sandbox.destroy()
    finally:
        await cleanup_spike_sandboxes()
        await assert_no_spike_sandboxes()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "scenario",
        choices=(
            "density",
            "recovery",
            "isolation",
            "prepare-server-restart",
            "verify-server-restart",
            "cleanup",
        ),
    )
    parser.add_argument("--max-sandboxes", type=int, default=100)
    parser.add_argument("--step", type=int, default=10)
    parser.add_argument("--create-concurrency", type=int, default=1)
    parser.add_argument("--evidence-label", default="sequential")
    args = parser.parse_args()

    guard_host()
    if args.scenario == "density":
        await run_density(args)
    elif args.scenario == "recovery":
        await run_recovery(args)
    elif args.scenario == "isolation":
        await run_isolation(args)
    elif args.scenario == "prepare-server-restart":
        await prepare_server_restart(args)
    elif args.scenario == "verify-server-restart":
        await verify_server_restart(args)
    else:
        await cleanup_spike_sandboxes()
        await assert_no_spike_sandboxes()


if __name__ == "__main__":
    asyncio.run(main())
