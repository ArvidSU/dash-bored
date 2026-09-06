#!/usr/bin/env python3
"""Opt-in release QA. Host orchestrates Docker; worker checks isolated user journeys."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent.parent


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def digest_tree(root):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file() and not p.is_symlink()}


def codex_metrics(text):
    """Extract reported metrics only; absent provider usage stays unknown."""
    usage = None
    commands = failures = 0
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(event, dict):
            continue
        if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
            usage = usage or {}
            for key, value in event["usage"].items():
                if isinstance(value, (int, float)):
                    usage[key] = usage.get(key, 0) + value
        item = event.get("item", {})
        if event.get("type") == "item.completed" and item.get("type") == "command_execution":
            commands += 1
            failures += item.get("exit_code") not in (None, 0)
    return dict(reported_usage=usage, command_count=commands, failed_command_count=failures)


class Evidence:
    def __init__(self, directory, timeout=120):
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout
        self.steps = []

    def run(self, name, argv, cwd=None, expected=0, env=None):
        start = time.monotonic()
        prefix = self.directory / f"{len(self.steps):02d}-{name}"
        timed_out = False
        with prefix.with_suffix(".stdout.log").open("w") as out, prefix.with_suffix(".stderr.log").open("w") as err:
            process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=out, stderr=err, start_new_session=True)
            try:
                code = process.wait(timeout=self.timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                code = process.wait()
        step = dict(name=name, exit_code=code, seconds=round(time.monotonic()-start, 3),
                    timed_out=timed_out, passed=code == expected and not timed_out)
        self.steps.append(step)
        save(self.directory / "steps.json", self.steps)
        if not step["passed"]:
            raise RuntimeError(f"{name}: exit {code}, expected {expected}, timeout={timed_out}")
        return prefix.with_suffix(".stdout.log").read_text()


def check_version(evidence, binary, version, name):
    actual = evidence.run(name, [binary, "--version"]).strip()
    if actual != version:
        raise RuntimeError(f"{name}: expected {version!r}, got {actual!r}")


def worker(args):
    out = Path("/evidence")
    evidence = Evidence(out, args.timeout)
    home = Path.home()
    project = home / "project"
    result = dict(scenario=args.scenario, agent_status="not-run", passed=False)
    try:
        auth = Path("/run/codex-auth.json")
        if auth.is_file():
            (home / ".codex").mkdir(exist_ok=True)
            shutil.copyfile(auth, home / ".codex/auth.json")
            (home / ".codex/auth.json").chmod(0o600)
        app_directory = home / "app"
        app_directory.mkdir(exist_ok=True)
        candidate = str(app_directory / "dash-bored")
        shutil.copy2("/opt/candidate/dash-bored", candidate)
        installed = str(home / ".local/bin/dash-bored")
        if args.scenario == "existing":
            # Manual app replacement keeps the bundled tool at a stable path.
            shutil.copy2("/opt/previous/dash-bored", candidate)
            old = candidate
            check_version(evidence, old, args.previous_version, "previous-version")
            evidence.run("previous-cli-install", [old, "install-cli"])
            evidence.run("previous-global-skill", [old, "install-skill", str(home)])
            existing = home / "existing-project"
            shutil.copytree("/qa/fixture", existing)
            evidence.run("previous-init", [old, "init", "."], existing)
            evidence.run("previous-project-skill", [old, "install-skill", "."], existing)
            before = {k: v for k, v in digest_tree(existing).items()
                      if not k.startswith((".agents/", ".claude/"))}
            shutil.copy2("/opt/candidate/dash-bored", candidate)
            evidence.run("app-startup-tool-refresh", ["/opt/candidate/bridge", "refresh"])
            after = {k: v for k, v in digest_tree(existing).items()
                     if not k.startswith((".agents/", ".claude/"))}
            save(out / "existing-project-hashes.json", {"before": before, "after": after})
            if before != after:
                raise RuntimeError("Update changed the existing dashboard bundle")
            evidence.run("updated-project-skill-check", [candidate, "install-skill", ".", "--check"], existing)
            try:
                evidence.run("existing-dashboard-validation", [candidate, "validate", "."], existing)
                result["existing_dashboard_compatible"] = True
            except RuntimeError as error:
                # Preserve the compatibility failure but still measure the requested new-project flow.
                result["existing_dashboard_compatible"] = False
                result["compatibility_error"] = str(error)
        else:
            evidence.run("cli-install", [candidate, "install-cli"])
            evidence.run("global-skill-install", [candidate, "install-skill", "--global"])
        check_version(evidence, installed, args.candidate_version, "installed-version")
        evidence.run("cli-check", [candidate, "install-cli", "--check"])
        evidence.run("global-skill-check", [candidate, "install-skill", "--global", "--check"])
        receipt = json.loads((home / ".agents/skills/dash-bored/skill-version.json").read_text())
        if receipt["skillVersion"] != args.candidate_version:
            raise RuntimeError("Skill version mismatch")
        save(out / "skill-version.json", receipt)
        shutil.copytree("/qa/fixture", project)
        evidence.run("initialize", [installed, "init", "."], project)
        evidence.run("project-skill-install", [installed, "install-skill", "."], project)
        evidence.run("project-skill-check", [installed, "install-skill", ".", "--check"], project)
        evidence.run("starter-validation", [installed, "validate", "."], project)
        evidence.run("fixture-test", ["bun", "run", "test"], project)
        evidence.run("fixture-build", ["bun", "run", "build"], project)
        shutil.copytree(project, out / "before")
        prompt = evidence.run("starter-prompt", ["/opt/candidate/bridge", "prompt"])
        (out / "prompt.txt").write_text(prompt)
        if args.agent_command:
            if not args.agent_version_command:
                raise RuntimeError("Live runs require --agent-version-command")
            evidence.run("agent-version", ["sh", "-lc", args.agent_version_command], project)
            before = digest_tree(project / ".dash-bored")
            env = dict(os.environ, DASH_BORED_AGENT_PROMPT=prompt)
            result["agent_status"] = "failed"
            evidence.run("agent", [installed, "agent", args.agent_command], project, env=env)
            evidence.run("agent-dashboard-validation", [installed, "validate", "."], project)
            evidence.run("agent-dashboard-inspect", [installed, "inspect", "."], project)
            if before == digest_tree(project / ".dash-bored"):
                raise RuntimeError("Agent exited successfully but did not change the dashboard")
            evidence.run("post-agent-fixture-test", ["bun", "run", "test"], project)
            result["agent_status"] = "validated-awaiting-review"
        result["onboarding_passed"] = True
        result["passed"] = result.get("existing_dashboard_compatible", True)
    except Exception as error:
        result["error"] = str(error)
    finally:
        existing = home / "existing-project"
        if existing.exists():
            shutil.copytree(existing, out / "existing-project", symlinks=True, dirs_exist_ok=True)
        if project.exists():
            shutil.copytree(project, out / "after", symlinks=True, dirs_exist_ok=True)
        agent_logs = list(out.glob("*-agent.stdout.log"))
        if agent_logs:
            result["agent_metrics"] = codex_metrics(agent_logs[0].read_text())
        result["steps"] = evidence.steps
        save(out / "result.json", result)
        (out / "review.md").write_text("""# Dashboard review (pending)

Technical pass does not establish usefulness. Cite log lines or project paths.
Score each item 0 (missing/broken), 1 (partial), 2 (meets fixture brief).

- Workflow coverage (README, test, build, health):
- Correct commands, paths and service assumptions:
- Discovery and reuse of installed skill/catalog:
- Clear layout and labels (open saved project in native app):
- Permissions and explicit execution behavior:
- Unnecessary work, retries, errors and recovery:
- Provider usage/cost (only when present in provider trace; otherwise unknown):
- Issues: severity, evidence, reproduction, suggested fix:
- Reviewer / date / release decision:

Native DMG installation, app replacement, trust UI and setup repair are untested here.
""")
    return 0 if result["passed"] else 1


def revision(ref):
    commit = subprocess.check_output(["git", "rev-parse", "--verify", ref + "^{commit}"], cwd=ROOT, text=True).strip()
    manifest = json.loads(subprocess.check_output(["git", "show", f"{commit}:package.json"], cwd=ROOT))
    return dict(ref=ref, commit=commit, version=manifest["version"])


def host(args):
    if args.repeats < 1 or args.timeout < 1:
        raise ValueError("repeats and timeout must be positive")
    previous, candidate = revision(args.previous), revision(args.candidate)
    if args.candidate_worktree:
        if args.candidate != "HEAD":
            raise ValueError("--candidate-worktree requires --candidate HEAD")
        candidate["version"] = json.loads((ROOT / "package.json").read_text())["version"]
        candidate["working_tree"] = True
    if previous["version"] == candidate["version"] and not args.allow_same_version:
        raise ValueError("Update QA requires distinct versions; --allow-same-version is for harness smoke checks only")
    output = Path(args.output).resolve() / (time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6])
    output.mkdir(parents=True)
    image = "dash-bored-release-qa:" + uuid.uuid4().hex[:12]
    metadata = dict(previous=previous, candidate=candidate, repeats=args.repeats, image=image,
                    agent_command=args.agent_command, agent_version_command=args.agent_version_command,
                    smoke_only=previous["version"] == candidate["version"], native_install="untested",
                    timeout_seconds=args.timeout, resources=dict(cpus=2, memory="4g", pids=256),
                    harness_files={k: v for k, v in digest_tree(Path(__file__).parent).items() if "__pycache__" not in k})
    save(output / "run.json", metadata)
    shutil.copytree(Path(__file__).parent, output / "harness", ignore=shutil.ignore_patterns("__pycache__"))
    evidence = Evidence(output, 1800)
    print(f"Evidence: {output}", flush=True)
    with tempfile.TemporaryDirectory(prefix="dash-bored-release-qa-") as temporary:
        context = Path(temporary)
        for name, rev in [("previous", previous), ("candidate", candidate)]:
            target = context / name
            target.mkdir()
            if name == "candidate" and args.candidate_worktree:
                names = subprocess.check_output(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT).decode().split("\0")
                for filename in set(filter(None, names)):
                    source = ROOT / filename
                    if source.is_file() or source.is_symlink():
                        destination = target / filename
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, destination, follow_symlinks=False)
                metadata["candidate"]["file_hashes"] = digest_tree(target)
                save(output / "run.json", metadata)
                continue
            archive = context / f"{name}.tar"
            with archive.open("wb") as stream:
                subprocess.run(["git", "archive", rev["commit"]], cwd=ROOT, stdout=stream, check=True)
            subprocess.run(["tar", "-xf", str(archive), "-C", str(target)], check=True)
            archive.unlink()
        for name in ["Dockerfile", "bridge.ts", "runner.py"]:
            shutil.copyfile(Path(__file__).parent / name, context / name)
        shutil.copytree(Path(__file__).parent / "fixture", context / "fixture")
        evidence.run("docker-build", ["docker", "build", "--build-arg", f"AGENT_SETUP={args.agent_setup}", "-t", image, str(context)])
    metadata["image_id"] = subprocess.check_output(["docker", "image", "inspect", "--format", "{{.Id}}", image], text=True).strip()
    save(output / "run.json", metadata)
    results = []
    for repeat in range(1, args.repeats + 1):
        for scenario in ["new", "existing"]:
            destination = output / f"{scenario}-{repeat}"
            destination.mkdir()
            destination.chmod(0o777)  # disposable evidence mount writable by container user
            name = "dash-bored-qa-" + uuid.uuid4().hex[:12]
            command = ["docker", "run", "--rm", "--name", name, "--cap-drop=ALL", "--security-opt=no-new-privileges",
                       "--cpus", "2", "--memory", "4g", "--pids-limit", "256",
                       "--mount", f"type=bind,source={destination},target=/evidence"]
            if args.codex_auth_file:
                command += ["--mount", f"type=bind,source={Path(args.codex_auth_file).resolve()},target=/run/codex-auth.json,readonly"]
            elif args.live_codex:
                command += ["--env", "CODEX_API_KEY"]
            if args.env_file:
                command += ["--env-file", str(Path(args.env_file).resolve())]
            command += [image, "--scenario", scenario, "--previous-version", previous["version"],
                        "--candidate-version", candidate["version"], "--timeout", str(args.timeout)]
            if args.agent_command:
                command += ["--agent-command", args.agent_command, "--agent-version-command", args.agent_version_command]
            try:
                evidence.timeout = args.timeout * 30 + 60
                evidence.run(f"{scenario}-{repeat}", command)
            except Exception as error:
                print(error, file=sys.stderr)
            finally:
                subprocess.run(["docker", "rm", "-f", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            result_file = destination / "result.json"
            results.append(json.loads(result_file.read_text()) if result_file.exists() else dict(scenario=scenario, passed=False, error="No worker result"))
    summary = {"technical_pass": all(r["passed"] for r in results), "runs": results,
               "qualitative_review": "pending", "agent_requested": bool(args.agent_command), "agent_evaluated": any(r.get("agent_status") == "validated-awaiting-review" for r in results)}
    for scenario in ["new", "existing"]:
        times = [s["seconds"] for r in results if r["scenario"] == scenario for s in r.get("steps", []) if s["name"] == "agent"]
        summary[scenario] = dict(runs=args.repeats, passed=sum(r["passed"] for r in results if r["scenario"] == scenario),
                                 agent_attempts=len(times),
                                 agent_validated=sum(r.get("agent_status") == "validated-awaiting-review" for r in results if r["scenario"] == scenario),
                                 agent_median_seconds=statistics.median(times) if times else None)
    save(output / "summary.json", summary)
    print(json.dumps({k: v for k, v in summary.items() if k != "runs"}, indent=2))
    return 0 if summary["technical_pass"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    run = sub.add_parser("run")
    run.add_argument("--previous", required=True, help="Previously installed release tag or commit")
    run.add_argument("--candidate", default="HEAD", help="Committed candidate revision (never includes dirty files)")
    run.add_argument("--candidate-worktree", action="store_true", help="Explicitly snapshot nonignored working files and record their hashes; candidate HEAD only")
    run.add_argument("--repeats", type=int, default=1)
    run.add_argument("--output", default=str(ROOT / "artifacts/release-qa"))
    run.add_argument("--agent-setup", default="true", help="Docker image setup command; pin the agent version")
    run.add_argument("--live-codex", action="store_true", help="Run pinned Codex with gpt-5.6-luna; requires an API key or --codex-auth-file")
    run.add_argument("--codex-auth-file", help="Read-only Codex auth.json, copied only into the disposable container home")
    run.add_argument("--env-file", help="Explicit agent credentials; never mounts host home")
    run.add_argument("--allow-same-version", action="store_true")
    work = sub.add_parser("worker")
    work.add_argument("--scenario", choices=["new", "existing"], required=True)
    work.add_argument("--previous-version", required=True)
    work.add_argument("--candidate-version", required=True)
    for command in [run, work]:
        command.add_argument("--timeout", type=int, default=600, help="Seconds per scenario step")
        command.add_argument("--agent-command", default="", help="Configured dash-bored agent command; opt-in live run")
        command.add_argument("--agent-version-command", default="", help="Command recording provider CLI version/model configuration")
    args = parser.parse_args()
    if args.mode == "run" and args.live_codex:
        key = os.environ.get("CODEX_API_KEY") or os.environ.get("OPENAI_API_KEY")
        if not key and not args.codex_auth_file:
            parser.error("--live-codex requires an API key or --codex-auth-file")
        if key:
            os.environ["CODEX_API_KEY"] = key
        args.agent_setup = "mkdir -p /opt/codex && cd /opt/codex && bun add @openai/codex@0.153.3 && ln -s /opt/codex/node_modules/.bin/codex /usr/local/bin/codex"
        args.agent_command = "codex exec --model gpt-5.6-luna --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox"
        args.agent_version_command = "codex --version"
    if args.agent_command and not args.agent_version_command:
        parser.error("--agent-command requires --agent-version-command")
    return worker(args) if args.mode == "worker" else host(args)


if __name__ == "__main__":
    sys.exit(main())
