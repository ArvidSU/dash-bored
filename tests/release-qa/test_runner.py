"""Failure reporting contracts; run explicitly outside ordinary Bun QA."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release_qa", Path(__file__).parents[2] / "scripts/release-qa/runner.py")
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class EvidenceTests(unittest.TestCase):
    def test_provider_usage_is_not_invented(self):
        self.assertIsNone(qa.codex_metrics("not json")["reported_usage"])
        metrics = qa.codex_metrics('{"type":"turn.completed","usage":{"input_tokens":17}}\n'
                                   '{"type":"item.completed","item":{"type":"command_execution","exit_code":1}}')
        self.assertEqual(metrics["reported_usage"], {"input_tokens": 17})
        self.assertEqual(metrics["failed_command_count"], 1)

    def test_failure_keeps_logs_and_exit_code(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = qa.Evidence(Path(directory))
            with self.assertRaises(RuntimeError):
                evidence.run("failed", [sys.executable, "-c", "print('evidence'); raise SystemExit(7)"])
            self.assertEqual(evidence.steps[0]["exit_code"], 7)
            self.assertIn("evidence", (Path(directory) / "00-failed.stdout.log").read_text())

    def test_timeout_is_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            evidence = qa.Evidence(Path(directory), timeout=0.05)
            with self.assertRaises(RuntimeError):
                evidence.run("timeout", [sys.executable, "-c", "import time; time.sleep(10)"])
            self.assertTrue(evidence.steps[0]["timed_out"])
            self.assertFalse(evidence.steps[0]["passed"])

    def test_version_mismatch_fails_even_on_clean_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "version"
            executable.write_text("#!/bin/sh\necho 0.1.0\n")
            executable.chmod(0o755)
            with self.assertRaisesRegex(RuntimeError, "expected '0.2.0'"):
                qa.check_version(qa.Evidence(Path(directory)), str(executable), "0.2.0", "version")


if __name__ == "__main__":
    unittest.main()
