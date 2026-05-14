# RevitMCPCommandSet Source

This folder contains the source for the dynamic Revit command set used by the
production `send_code_to_revit`, `get_current_view_elements`,
`get_current_view_info`, and `get_selected_elements` command payload.

The source was imported from the MIT-licensed
`mcp-servers-for-revit/mcp-servers-for-revit` command set and adapted for this
monorepo's Revit 2022-2025 source matrix. The deployed command surface remains
limited by `command.json` and the installer command registry.

The project is safe to build from this repo. It does not copy files into the
user Revit add-in folder unless `RevitMcpDeployCommandSet=true` is passed
explicitly.

The current production binary payload under `installer/command-payload` is kept
as the runtime contract unless the build script is run with an explicit command
set payload refresh.
