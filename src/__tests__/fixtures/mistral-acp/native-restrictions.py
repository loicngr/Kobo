"""Offline characterization, run with the Python environment containing Vibe 3.0.1.

This tests native configuration and permission code, not a fake ACP peer. It is
not a production wrapper and demonstrates why restricted launches are unsupported.
"""

import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile


def deny_network(event, args):
    if event == "socket.connect":
        raise AssertionError("Network access is forbidden in this probe")


sys.addaudithook(deny_network)


async def characterize(root):
    import vibe
    from vibe.app_server._runtime import (
        ToolGate,
        _effective_bypass_tool_permissions,
        _rust_tool_modes,
    )
    from vibe.app_server._unified_permissions import UnifiedPermissionResolver
    from vibe.core.agents.manager import AgentManager
    from vibe.core.agents.models import BUILTIN_AGENTS, REMOVED_BUILTIN_AGENTS
    from vibe.core.config.default_orchestrator import build_default_orchestrator
    from vibe.core.config.harness_files import HarnessFilesManager, init_harness_files_manager
    from vibe.core.config.layers.admin import AdminConfigLayer
    from vibe.core.tools.manager import ToolManager
    from vibe.core.tools.permissions import PermissionStore
    from vibe.core.trusted_folders import TrustedFoldersManager

    assert vibe.__version__ == "3.0.1", "Re-characterize other versions separately"
    assert "plan" not in BUILTIN_AGENTS
    assert REMOVED_BUILTIN_AGENTS["plan"] == "ask"
    init_harness_files_manager("user")
    project = root / "project"
    (project / ".vibe").mkdir(parents=True)
    permissive = 'bypass_tool_permissions = true\n[tools.write_file]\npermission = "always"\n'
    (root / "native" / "config.toml").write_text(permissive)
    (project / ".vibe" / "config.toml").write_text(permissive)
    trust = TrustedFoldersManager()
    trust.trust_for_session(project)
    harness = HarnessFilesManager(sources=("user", "project"), cwd=project, trust_store=trust)
    orchestrator = await build_default_orchestrator(harness_files=harness)
    agents = AgentManager(orchestrator, initial_agent="ask", harness_files=harness)
    store = PermissionStore()
    tools = ToolManager(
        lambda: orchestrator.config,
        defer_mcp=True,
        permission_getter=store.get_tool_permission,
        cwd=project,
        harness_files=harness,
    )
    resolver = UnifiedPermissionResolver(tools, store, orchestrator)
    target = project / "mutation.txt"
    arguments = {"path": str(target), "content": "probe"}
    safe = await resolver.resolve("file_system.write_file", arguments)
    assert safe.decision == "deny", safe
    assert not target.exists()
    assert not _effective_bypass_tool_permissions(orchestrator.config, False)
    modes = _rust_tool_modes(
        set(tools.available_tools),
        lambda name: tools.get_tool_config(name).permission,
        lambda name: tools.get_tool_config(name).allowlist,
        gate=ToolGate.PROMPT,
    )
    assert modes["file_system.bash"] == "deny", modes
    assert "task" not in tools.available_tools

    # A remembered whole-tool grant is applied after the effective tool config.
    from vibe.core.tools.base import ToolPermission

    store.set_tool_permission("write_file", ToolPermission.ALWAYS)
    remembered = await resolver.resolve("file_system.write_file", arguments)
    assert remembered.decision == "allow", remembered

    # A native profile discovered from the user's directory outranks VIBE_*.
    profiles = root / "native" / "agents"
    profiles.mkdir()
    (profiles / "ask.toml").write_text(
        'enable_auto_approve = true\nbypass_tool_permissions = true\n'
        '[tools.write_file]\npermission = "always"\n'
    )
    agents = AgentManager(orchestrator, initial_agent="ask", harness_files=harness)
    assert _effective_bypass_tool_permissions(orchestrator.config, False)
    assert agents.active_profile.name == "ask"

    # Even a process-supplied restrictive profile cannot outrank enforced admin.
    from vibe.core.agents.registry import apply_profile_overrides

    apply_profile_overrides(orchestrator, {
        "enable_auto_approve": False,
        "bypass_tool_permissions": False,
        "tools": {"write_file": {"permission": "never", "allowlist": []}},
    })
    assert not _effective_bypass_tool_permissions(orchestrator.config, False)
    orchestrator.replace_or_append_layer("admin", AdminConfigLayer(data={
        "enable_auto_approve": True,
        "bypass_tool_permissions": True,
        "tools": {"write_file": {"permission": "always"}},
    }))
    orchestrator.rebuild()
    assert _effective_bypass_tool_permissions(orchestrator.config, False)
    unsafe_modes = _rust_tool_modes(
        set(tools.available_tools),
        lambda name: tools.get_tool_config(name).permission,
        lambda name: tools.get_tool_config(name).allowlist,
        gate=ToolGate.BYPASS,
    )
    assert unsafe_modes["file_system.write_file"] == "allow", unsafe_modes
    return {
        "version": vibe.__version__,
        "planAvailable": False,
        "removedPlanFallback": "ask",
        "environmentOverridesUserAndProject": True,
        "restrictedFileDecision": safe.decision,
        "restrictedShellMode": modes["file_system.bash"],
        "restrictedDelegationAvailable": False,
        "rememberedWriteDecision": remembered.decision,
        "customAskOverridesEnvironment": True,
        "adminOverridesRestrictiveProfile": True,
        "adminWriteMode": unsafe_modes["file_system.write_file"],
        "networkConnections": 0,
        "restrictedLaunchGate": "blocked",
    }


with tempfile.TemporaryDirectory(prefix="kobo-vibe-native-") as temporary:
    root = Path(temporary)
    native = root / "native"
    native.mkdir()
    inherited = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    os.environ.clear()
    os.environ.update(inherited)
    os.environ.update({
        "VIBE_HOME": str(native),
        "VIBE_ENABLE_TELEMETRY": "false",
        "VIBE_ENABLE_AUTO_APPROVE": "false",
        "VIBE_BYPASS_TOOL_PERMISSIONS": "false",
        "VIBE_ENABLED_TOOLS": '["read_file", "write_file", "bash"]',
        "VIBE_TOOLS": json.dumps({name: {"permission": "never", "allowlist": []} for name in ("write_file", "bash")}),
    })
    print(json.dumps(asyncio.run(characterize(root)), indent=2))
