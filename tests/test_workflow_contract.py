import unittest
from pathlib import Path


class WorkflowContractTests(unittest.TestCase):
    def setUp(self):
        self.source = Path(".github/workflows/Checkin.yml").read_text(encoding="utf-8")

    def test_summary_waits_for_all_workers(self):
        notify = self.source.split("  notify:", 1)[1].split("  maintenance:", 1)[0]
        self.assertIn("needs: [prepare, plan, checkin]", notify)
        self.assertIn("if: always()", notify)
        self.assertIn("python report.py notify", notify)

    def test_no_worker_bot_dispatch_and_only_safe_result_artifact(self):
        worker = self.source.split("  checkin:", 1)[1].split("  notify:", 1)[0]
        self.assertIn("CHECKIN_MODE: ${{ env.CHECKIN_MODE }}", worker)
        self.assertIn("checkin-results-${{ env.GROUP_ID }}", worker)
        self.assertIn("routing.py assign", worker)
        self.assertIn("ACCOUNT_IDS: ${{ env.ACCOUNT_IDS }}", worker)
        self.assertIn("path: ${{ runner.temp }}/result.json", worker)
        self.assertNotIn("report.py notify", worker)
        self.assertNotIn("send_telegram", worker)
        self.assertNotIn("send_wecom", worker)

    def test_failures_do_not_cancel_other_groups(self):
        self.assertIn("fail-fast: false", self.source)
        self.assertIn("max-parallel: 3", self.source)
        self.assertIn("cancel-in-progress: false", self.source)
        self.assertIn("needs.plan.outputs.matrix != ''", self.source)
        self.assertIn("CHECKIN_CONFIG: ${{ secrets.CHECKIN_CONFIG }}", self.source)
        self.assertNotIn("pull_request_target:", self.source)

    def test_scheduled_and_manual_branches_cannot_overlap_accounts(self):
        self.assertIn("group: daily-checkin\n", self.source)

    def test_maintenance_only_once_and_browser_cache_per_architecture(self):
        self.assertEqual(self.source.count("name: Keep repository alive"), 1)
        self.assertIn("${{ runner.arch }}", self.source)
        self.assertIn("playwright==1.64.1", self.source)
        self.assertIn("cron: '45 22 * * *'", self.source)
        self.assertNotIn("git reset --hard", self.source)

    def test_smoke_contains_no_secrets(self):
        source = Path(".github/workflows/Smoke.yml").read_text(encoding="utf-8")
        self.assertIn("ubuntu-24.04", source)
        self.assertIn("windows-2022", source)
        self.assertIn("macos-15", source)
        self.assertIn("python tests/smoke.py", source)
        self.assertNotIn("secrets.", source)


if __name__ == "__main__":
    unittest.main()
