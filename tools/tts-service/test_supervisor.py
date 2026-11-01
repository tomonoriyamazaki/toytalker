import unittest
from unittest.mock import Mock, patch

import supervisor as service


class RecoveryTests(unittest.TestCase):
    def component(self):
        return service.Component("api", ["python.exe", "api_server.py"], "api_server.py", {"root": "C:/tts"})

    @patch.object(service, "find_process")
    @patch.object(service.subprocess, "Popen")
    def test_existing_server_is_adopted_without_duplicate(self, spawn, find):
        process = Mock(pid=42)
        find.return_value = process
        component = self.component()
        component.ensure_running()
        self.assertIs(component.process, process)
        self.assertFalse(component.owned)
        spawn.assert_not_called()

    @patch.object(service.time, "monotonic")
    @patch.object(service, "find_process")
    def test_exited_process_has_restart_backoff(self, find, clock):
        component = self.component()
        component.process = Mock()
        component.process.is_running.return_value = False
        clock.return_value = 100
        component.ensure_running()
        find.assert_not_called()
        clock.return_value = 131
        find.return_value = Mock(pid=43)
        component.ensure_running()
        find.assert_called_once()

    @patch.object(service.time, "monotonic", return_value=701)
    def test_health_timeout_only_terminates_owned_process(self, clock):
        component = self.component()
        component.process = Mock()
        component.failed_since = 100
        component.health(False)
        component.process.terminate.assert_not_called()
        component.owned = True
        component.health(False)
        component.process.terminate.assert_called_once()

    @patch.object(service.time, "monotonic", return_value=400)
    def test_slow_model_start_gets_grace_period(self, clock):
        component = self.component()
        component.process = Mock()
        component.owned = True
        component.failed_since = 100
        component.health(False)
        component.process.terminate.assert_not_called()
        component.health(True)
        self.assertIsNone(component.failed_since)

    @patch.object(service, "aws")
    def test_url_update_preserves_other_settings_and_uses_revision(self, aws):
        import json
        aws.return_value = {"RevisionId": "revision-1", "Environment": {"Variables": {"OTHER": "keep"}}}
        service.synchronize_urls({}, "https://example.test")
        updates = [call.args for call in aws.call_args_list if call.args[2] == "update-function-configuration"]
        self.assertEqual(len(updates), len(service.FUNCTIONS))
        for args in updates:
            self.assertEqual(args[args.index("--revision-id") + 1], "revision-1")
            values = json.loads(args[args.index("--environment") + 1])["Variables"]
            self.assertEqual(values, {"OTHER": "keep", "ZAKICORP_TTS_URL": "https://example.test"})

    @patch.object(service, "aws")
    def test_unchanged_url_never_updates_lambda(self, aws):
        aws.return_value = {"Environment": {"Variables": {"ZAKICORP_TTS_URL": "https://example.test"}}}
        service.synchronize_urls({}, "https://example.test")
        self.assertEqual(len(aws.call_args_list), len(service.FUNCTIONS))
        self.assertTrue(all(call.args[2] == "get-function-configuration" for call in aws.call_args_list))



class QueueWatchTests(unittest.TestCase):
    @patch.object(service.time, "monotonic")
    def test_warns_on_queue_or_wait_at_most_every_five_minutes(self, clock):
        watch = service.QueueWatch({})
        clock.return_value = 1000
        self.assertFalse(watch.observe(None))
        self.assertFalse(watch.observe({"pending": 3}))   # engine without the counters
        self.assertFalse(watch.observe({"queue_length": 0, "max_wait_ms": 200}))
        self.assertTrue(watch.observe({"queue_length": 2, "max_wait_ms": 0}))
        clock.return_value = 1100
        self.assertFalse(watch.observe({"queue_length": 2, "max_wait_ms": 0}))
        clock.return_value = 1301
        self.assertTrue(watch.observe({"queue_length": 0, "max_wait_ms": 1500}))


if __name__ == "__main__":
    unittest.main()
