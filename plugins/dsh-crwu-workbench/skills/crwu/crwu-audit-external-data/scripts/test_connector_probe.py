#!/usr/bin/env python3
"""connector_probe 的单元测试（纯标准库；用临时目录造假宿主配置，不触碰真实凭据）。

`connector_probe.py` 只探测一类事实：**WorkBuddy 宿主连接器声明**（`ifind-mcp`）。
它不再搜索、不再判断任何 DSH 技能目录 —— DSH 侧的取数入口是宿主的结构化 Tool，
可见性由宿主决定，不属于本探测器。因此这里只覆盖 WorkBuddy 行为，并额外锁死
"探测器里不得再出现技能探测接口与字段"这条实现边界。

本测试只依赖同目录的 connector_probe.py —— 本技能单独安装时也能通过。
"""
from __future__ import annotations

import contextlib
import inspect
import io
import json
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import connector_probe as probe  # noqa: E402

PROBE_SOURCE = Path(__file__).resolve().parent / "connector_probe.py"

FAKE_TOKEN = "FAKE-SECRET-TOKEN-1234567890"

# 实现边界：这些标识只属于已删除的 DSH 技能探测路径，源码里不得再出现
# （含注释）。扫描覆盖整个文件，不区分代码与注释。
FORBIDDEN_MARKERS = (
    "ifind-finance-data",
    "HARNESS_SKILL_ID",
    "SKILLS_ROOT_ENV",
    "DEFAULT_SKILLS_ROOTS",
    "find_harness_skill",
    "classify_skill",
    "call\\.py",
    "call-node\\.js",
    "mcp_config\\.json",
    "--skills-root",
    "harnessSkill",
    "harness_skill",
)

# 旧输出里属于 DSH 技能路径的字段，必须一个都不剩。
FORBIDDEN_RESULT_KEYS = ("skillsRoots", "harnessSkill", "harnessSkillVerdict", "harness_skill")


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def build_root(
    root: Path,
    *,
    declare_ifind: bool = True,
    ifind_disabled: bool | None = None,
    enabled: list | None = None,
    stored_auth: list | None = None,
    ever: list | None = None,
    auth_mode: str = "server-side",
) -> None:
    """造一个 WorkBuddy 风格的宿主连接器根目录。"""
    servers = {}
    if declare_ifind:
        entry = {"url": "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-mcp?token=%s" % FAKE_TOKEN}
        if ifind_disabled is not None:
            entry["disabled"] = ifind_disabled
        servers["connector:ifind-mcp"] = entry
    write_json(root / "mcp.json", {"mcpServers": servers})

    state_dir = root / "connectors" / "00000000-1111-2222-3333-444444444444"
    write_json(
        state_dir / "connector-states.v3.json",
        {
            "enabled": enabled if enabled is not None else ["ifind-mcp"],
            "userDisabled": {},
            "everConnected": ever if ever is not None else ["ifind-mcp"],
            "headerOverrides": {
                name: {"Authorization": {"iv": "x", "ct": FAKE_TOKEN}}
                for name in (stored_auth if stored_auth is not None else ["ifind-mcp"])
            },
        },
    )
    write_json(
        root / "connectors-marketplace" / ".codebuddy-connector" / "connectors.json",
        {
            "connectors": [
                {"id": "ifind-mcp", "name_zh": "同花顺iFinD金融数据查询", "auth_mode": auth_mode},
            ]
        },
    )


class ProbeTest(unittest.TestCase):
    def test_host_connector_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            result = probe.probe(root)
            ifind = result["targets"]["ifind"]
            self.assertEqual("available", ifind["state"])
            self.assertEqual("host_connector", ifind["accessPath"])
            self.assertEqual("ifind-mcp", ifind["connectorId"])
            self.assertEqual("api-mcp.51ifind.com", ifind["endpointHost"])
            self.assertEqual("stored_authorization", ifind["authEvidence"])

    def test_catalog_only_connector_is_not_declared(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root, declare_ifind=False, enabled=[], stored_auth=[])
            ifind = probe.probe(root)["targets"]["ifind"]
            self.assertEqual("not_declared", ifind["state"])
            self.assertIn("目录", ifind["reason"])

    def test_connector_declared_but_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root, ifind_disabled=True, enabled=[], stored_auth=[])
            self.assertEqual("declared_disabled", probe.probe(root)["targets"]["ifind"]["state"])

    def test_connector_not_in_enabled_list_is_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root, enabled=[], stored_auth=["ifind-mcp"])
            self.assertEqual("declared_disabled", probe.probe(root)["targets"]["ifind"]["state"])

    def test_other_account_state_disabled_does_not_override_active_state(self):
        """真实场景：connectors/default 把 ifind 标为 disabled=true，但当前账号态已启用且连过。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            write_json(
                root / "connectors" / "default" / "mcp.json",
                {
                    "mcpServers": {
                        "connector:ifind-mcp": {
                            "url": "https://api-mcp.51ifind.com:8643/ds-mcp-servers/hexin-ifind-mcp",
                            "disabled": True,
                        }
                    }
                },
            )
            result = probe.probe(root)
            self.assertEqual("connectors/00000000-1111-2222-3333-444444444444", result["activeStateScope"])
            self.assertEqual("available", result["targets"]["ifind"]["state"])

    def test_missing_everything_is_reported_not_guessed(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / "nope"
            result = probe.probe(missing)
            self.assertFalse(result["rootExists"])
            self.assertEqual("not_declared", result["targets"]["ifind"]["state"])
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = probe.main(["--root", str(missing), "--format", "json"])
            self.assertEqual(2, code)
            self.assertEqual([], json.loads(buffer.getvalue())["connectors"])

    def test_main_returns_zero_when_connector_available(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = probe.main(["--root", str(root), "--format", "json"])
            self.assertEqual(0, code)
            self.assertEqual("host_connector", json.loads(buffer.getvalue())["targets"]["ifind"]["accessPath"])

    def test_token_auth_without_evidence_exits_two(self):
        """已声明且启用、但授权形态是 token 且无任何授权证据 → 预检不可用（退出码 2）。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root, stored_auth=[], ever=[], auth_mode="token")
            buffer = io.StringIO()
            with contextlib.redirect_stdout(buffer):
                code = probe.main(["--root", str(root), "--format", "json"])
            self.assertEqual(2, code)
            self.assertEqual("likely_unauthenticated", json.loads(buffer.getvalue())["targets"]["ifind"]["state"])

    def test_never_leaks_credentials(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            result = probe.probe(root)
            payload = json.dumps(result, ensure_ascii=False)
            self.assertNotIn(FAKE_TOKEN, payload)
            self.assertNotIn('"Authorization"', payload)
            self.assertNotIn(FAKE_TOKEN, probe.render_text(result))

    def test_text_format_excludes_wind(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            text = probe.render_text(probe.probe(root))
            self.assertIn("同花顺 iFinD", text)
            self.assertNotIn("万得", text)
            self.assertNotIn("wind", text.lower())

    def test_env_var_supplies_default_connector_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            buffer = io.StringIO()
            old = os.environ.get(probe.DEFAULT_ROOT_ENV)
            os.environ[probe.DEFAULT_ROOT_ENV] = str(root)
            try:
                with contextlib.redirect_stdout(buffer):
                    code = probe.main(["--format", "json"])
            finally:
                if old is None:
                    os.environ.pop(probe.DEFAULT_ROOT_ENV, None)
                else:
                    os.environ[probe.DEFAULT_ROOT_ENV] = old
            self.assertEqual(0, code)
            self.assertEqual("available", json.loads(buffer.getvalue())["targets"]["ifind"]["state"])

    # ---- 以下用例锁定"探测器只探测 WorkBuddy"这条实现边界 ----

    def test_probe_signature_takes_only_the_connector_root(self):
        """`probe()` 只接宿主连接器根；skills 根形参不是可选项，而是必须不存在。"""
        parameters = list(inspect.signature(probe.probe).parameters)
        self.assertEqual(["root"], parameters, "probe() must only accept the WorkBuddy connector root")

    def test_cli_no_longer_accepts_skills_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as caught:
                    probe.main(["--root", tmp, "--skills-root", tmp, "--format", "json"])
            self.assertEqual(2, caught.exception.code, "argparse must reject the removed --skills-root option")

    def test_result_json_has_no_skill_path_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            result = probe.probe(root)
            for key in FORBIDDEN_RESULT_KEYS:
                self.assertNotIn(key, result, "probe result must not expose %s" % key)
                self.assertNotIn(key, result["targets"]["ifind"], "ifind target must not expose %s" % key)
            self.assertNotEqual("harness_skill", result["targets"]["ifind"]["accessPath"])

    def test_render_text_has_no_skill_path_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workbuddy"
            build_root(root)
            text = probe.render_text(probe.probe(root))
            for marker in ("skillsRoots", "Harness 技能根", "Harness 技能：", "harness_skill"):
                self.assertNotIn(marker, text, "text rendering must not mention %s" % marker)

    def test_source_has_no_dsh_skill_probe_markers(self):
        """实现边界硬判据：源码（含注释）不得再出现技能探测路径的任何标识。"""
        source = PROBE_SOURCE.read_text(encoding="utf-8")
        hits = sorted({marker for marker in FORBIDDEN_MARKERS if re.search(marker, source)})
        self.assertEqual([], hits, "connector_probe.py must not contain: %s" % ", ".join(hits))


if __name__ == "__main__":
    unittest.main()
