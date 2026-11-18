"""Stdlib checks: run with the Python environment selected for the optional pilot."""

import importlib.util
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch
from urllib.error import HTTPError

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "pugport_hindsight_service", Path(__file__).resolve().parents[1] / "scripts" / "hindsight-service.py"
)
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class ServiceAuthenticationTests(unittest.TestCase):
    def test_engine_receives_explicit_tenant_authentication(self):
        modules = {name: ModuleType(name) for name in (
            "hindsight_api", "hindsight_api.api", "hindsight_api.extensions.builtin.tenant"
        )}
        engine = modules["hindsight_api"].MemoryEngine = Mock()
        tenant = modules["hindsight_api.extensions.builtin.tenant"].ApiKeyTenantExtension = Mock()
        app = modules["hindsight_api.api"].create_app = Mock()
        config = dict(databaseUrl="pg0://synthetic", bridgeToken="bridge-only",
                      bridgeUrl="http://127.0.0.1:1/v1", token="service-only")
        with patch.dict("sys.modules", modules):
            self.assertIs(service.create_authenticated_app(config), app.return_value)
        tenant.assert_called_once_with({"api_key": "service-only"})
        self.assertIs(engine.call_args.kwargs["tenant_extension"], tenant.return_value)
        self.assertEqual(engine.call_args.kwargs["memory_llm_api_key"], "bridge-only")
        app.assert_called_once_with(memory=engine.return_value, mcp_api_enabled=False, initialize_memory=True)

    def test_readiness_requires_denied_missing_and_wrong_keys_and_a_valid_key(self):
        for statuses, passes in (((401, 401, 200), True), ((200, 401, 200), False),
                                 ((401, 200, 200), False), ((401, 401, 401), False)):
            with self.subTest(statuses=statuses):
                seen = []

                def open_request(request, timeout):
                    self.assertEqual(timeout, 5)
                    seen.append(request.get_header("Authorization"))
                    status = statuses[len(seen) - 1]
                    if status != 200:
                        raise HTTPError(request.full_url, status, "Synthetic denial", {}, None)
                    response = Mock(status=status)
                    response.__enter__ = Mock(return_value=response)
                    response.__exit__ = Mock(return_value=False)
                    return response

                with patch.object(service.urllib.request, "urlopen", side_effect=open_request):
                    if passes:
                        service.verify_authentication("http://127.0.0.1:1", "synthetic")
                        self.assertEqual(seen, [None, "Bearer invalid-synthetic", "Bearer synthetic"])
                    else:
                        with self.assertRaisesRegex(RuntimeError, "authentication check failed"):
                            service.verify_authentication("http://127.0.0.1:1", "synthetic")


if __name__ == "__main__":
    unittest.main()
