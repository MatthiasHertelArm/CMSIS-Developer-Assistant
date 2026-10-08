[![License Apache-2.0 OR MIT](https://img.shields.io/badge/License-Apache--2.0%20OR%20MIT-green?label=LICENSE)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/blob/main/LICENSE)
[![CI Build and Test](https://img.shields.io/github/actions/workflow/status/Open-CMSIS-Pack/CMSIS-Developer-Assistant/ci.yml?logo=arm&logoColor=0091bd&label=CI%20Build%20and%20Test)](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/actions/workflows/ci.yml?query=branch:main)

# CMSIS Developer Assistant

![CMSIS Developer Assistant workflow](assets/cmsis-developer-assistant.png)

The CMSIS Developer Assistant gives an AI agent controlled access to the CMSIS build
system, debugger, target registers, project documentation, and connected
hardware. The AI agent becomes more than a code generator: it can participate in
the complete embedded development lifecycle while you remain in control.

Traditional embedded development is a human-driven loop: understand the
requirements, configure the project, write code, build, flash, debug, analyze,
and repeat. AI-supported development changes where you spend your time. You
define the goal, agree on the specification and test criteria, and review the
result. Your AI coding agent can take on much of the repetitive loop: plan,
implement, build, deploy, observe the real hardware, reason about failures, and
iterate.

## What you can do

- **Turn intent into working embedded software.** Start with a goal and let the
  agent help plan, create, integrate, and verify the implementation.
- **Work across the CMSIS ecosystem.** Bring projects, software packs, tools,
  documentation, and target hardware into one guided workflow.
- **Close the loop on real hardware.** Build and deploy software, observe its
  behavior on the target, reason about failures, and iterate against test
  criteria.
- **Apply reusable expert workflows.** Use AI Skills for project setup, device
  bring-up, debugging, CMSIS-Pack development, and automation.

> [!TIP]
> **Working with Zephyr:** use a csolution project to describe the selectable
> Zephyr applications, build configurations, and target hardware. Zephyr and
> `west` still configure and build the application, while CMSIS adds the project,
> programming, debug, peripheral, and trace information used by the development
> tools. See the
> [CMSIS-Zephyr examples](https://github.com/Arm-Examples/CMSIS-Zephyr).

## How it works

The extension combines three complementary capabilities:

- **AI Skills** teach agents reliable CMSIS workflows, such as starting a
  project, adding a board layer, consulting pack documentation, and debugging a
  live Cortex-M target. Skills act as reusable cookbooks: they define the
  expected workflow, identify the tools to use, and set boundaries that keep
  the agent on a predictable path.
- **MCP tools** let agents perform those workflows through VS Code: build and
  flash, control the debugger, inspect the target, use serial ports, and read
  project documentation and build artifacts.
- **Target context** gives the agent device- and project-specific knowledge from
  the CMSIS solution, generated build and run descriptions, software packs,
  SVD files, examples, and linked documentation. This lets the agent use the
  configuration and tools selected by the project instead of rediscovering or
  guessing them.

Together, these capabilities help the agent follow repeatable workflows, use
the established CMSIS tools, and base its decisions on the actual target and
project configuration.

The extension helps configure supported coding agents and installs the selected
skills. GitHub Copilot in VS Code discovers the MCP server automatically.
The integration has been tested with Codex, Claude Code, and GitHub Copilot.
Other agents that support MCP and the Agent Skills format may also work.

## Requirements

CMSIS Developer Assistant is free to use and works in combination with:

- [CMSIS Solution](https://marketplace.visualstudio.com/items?itemName=Arm.cmsis-csolution) to
  create, configure, and build CMSIS solutions.
- [CMSIS Debugger](https://marketplace.visualstudio.com/items?itemName=Arm.vscode-cmsis-debugger) to
  program and debug Arm Cortex-M targets.
- An AI coding agent that supports MCP and, for guided workflows, the
  [Agent Skills](https://agentskills.io/) format.

## Get started

1. Install [Arm Keil Studio](https://marketplace.visualstudio.com/items?itemName=Arm.keil-studio-pack) and CMSIS Developer Assistant in VS Code.
2. Open the [command palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette) and run
   **CMSIS Developer Assistant: Configure Agent**: it registers the MCP server
   with the agents you pick, installs the CMSIS skills for them, and offers
   the tool rules for their instruction files.
3. Open an existing CMSIS solution, or start with an empty VS Code window and
   ask the agent to create one.
4. Describe the outcome you want and let the agent use the installed skills and
   MCP tools.

## Supported development tasks

CMSIS Developer Assistant supports these embedded development activities:

- Creating and extending CMSIS and Zephyr projects.
- Adding targets, boards, layers, startup code, standard I/O, and debugger
  configuration.
- Building, programming, running, attaching to, and debugging Cortex-M
  firmware.
- Diagnosing HardFaults, crashes, hangs, peripheral failures, and timing issues.
- Inspecting memory, registers, variables, call stacks, SVD peripherals, and
  cycle counts.
- Searching target manuals, datasheets, errata, and Arm documentation with page
  citations.
- Analyzing ELF symbols, memory usage, linker sections, build logs, and errors.
- Creating GitHub Actions for CMSIS solution builds and optional FVP tests.
- Communicating with target hardware over serial ports.
- Troubleshooting pyOCD, J-Link, debug probes, Flash programming, and Arm FVP
  sessions.

For example:

- > Create a Blinky project for my board, build it, program the target, and
  > stop at `main`.
- > Find out why the application enters the HardFault handler and propose a
  > fix.
- > Check whether the GPIO output toggles at the required rate and iterate
  > until the test passes.
- > Add a board layer with UART standard I/O, then build and test it on
  > hardware.

## How you stay in control

You set the goal, approve the specification, and decide when the result is
ready. The lifecycle below shows how the agent handles the implementation loop
while you retain the key review and approval points.

![AI Supported Development Lifecycle](assets/ai-development-lifecycle.png)

Following that lifecycle, a typical workflow is:

1. **Define the goal.** Describe the intended outcome and relevant constraints.
2. **Create and review a specification.** Ask the agent to define requirements,
   interfaces, and measurable test criteria before implementation begins.
3. **Implement and iterate.** Let the agent plan the work, modify the software,
   build and deploy it, observe the real hardware, and reason about failures
   until the agreed criteria are met.
4. **Verify the result.** Review the code and the evidence from builds, tests,
   and target observations before accepting and delivering the result.

The agent works through the same CMSIS project and debugger integrations that
you use in VS Code. Source changes, build output, debug state, and tool results
remain available for review. Actions that affect the target, such as programming
Flash or changing execution state, are explicit MCP tool calls and remain
subject to your coding agent's approval settings.

The MCP server listens only on the local machine. It does not expose the
debugger or connected target to the network. Your chosen AI coding agent may
process prompts and tool results according to that agent's own service and
privacy terms.

## Help and feedback

- Ask the agent, “What can I do with CMSIS Developer Assistant?” to use the
  `/cmsis-help` skill.
- See the [user guide](docs/user-guide.md) for every MCP tool and its
  parameters, the settings, manual agent registration, networking with
  several VS Code windows, and the known limitations and workarounds.
- Report problems and request features in
  [GitHub Issues](https://github.com/Open-CMSIS-Pack/CMSIS-Developer-Assistant/issues).
- See [CHANGELOG.md](CHANGELOG.md) for release notes.
- Report security vulnerabilities as described in
  [SECURITY.md](SECURITY.md).

## Commands

Open the
[command palette](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette)
and type **CMSIS Developer Assistant** to find them.

| Command | What it does |
|---------|--------------|
| **Configure Agent** | Register agents, install the CMSIS skills for them, and add tool rules to agent instruction files. |
| **Select Target Window** | Choose which VS Code window receives agent calls, or use automatic selection. |
| **Release Serial Port** | Return an agent-held serial port to the Serial Monitor or another application. |
| **List Target Documentation** | List the current target's manuals, datasheets, Arm documents, and imported PDFs. |
| **Index Target Documentation** | Index all target PDFs now so searches are immediately available. |
| **Import Document for Current Target** | Import and attribute PDFs that are not supplied by a software pack. |
| **Open User Documents Folder** | Open the folder containing imported target documentation. |
| **Open Pack Docs Panel** | Inspect target documents, SVD peripherals, index state, and documentation tools. |
| **Copy Recent Problems** | Copy recent errors and warnings, with their source and suggested next step. |

The [extension setting](https://code.visualstudio.com/docs/configure/settings#_extension-settings)
`cmsis-developer-assistant.packDocs.enabled` controls whether agents
receive the documentation tools. The five documentation commands above remain
available regardless of that setting. They use the built csolution to identify
the target, or ask you to select the pack and device when it cannot be resolved.

## Choose a workflow

Use a slash command in the chat window to start a guided CMSIS workflow:

- `/cmsis-bootstrap` — create a project from an empty VS Code window.
- `/cmsis-project` — create, extend, or retarget a CMSIS or Zephyr project.
- `/add-board-layer` — generate and integrate a board layer.
- `/cmsis-debug-live` — investigate firmware on a connected Cortex-M target.
- `/cmsis-pack-docs` — search target documentation with page citations.
- `/create-csolution-github-action` — create a GitHub Actions workflow that
  builds the solution and optionally tests it on an FVP.
- `/cmsis-help` — list the available workflows, tools, and settings.

**Configure Agent** installs all of them, together with the member skills
they hand over to, into your personal skills directories; there is nothing to
select.

### Workflow categories

Workflows combine focused AI Skills from these categories:

| Category | What the skills cover |
|----------|-----------------------|
| **Project** | Create, inspect, extend, and manage CMSIS and Zephyr projects. |
| **Debug** | Set up the debugger, debug a live target, and find out why a session fails. |
| **DevOps** | Automate builds and tests with GitHub Actions. |

The project and DevOps skills come from the
[generic MCU skills catalog](https://github.com/Open-CMSIS-Pack/cmsis-skills/blob/main/generic-mcu-skills/README.md),
which also holds skills for CMSIS-Pack authors (device debug and trace
knowledge, PDSC debug and trace sequences) and for Ethos-U model evaluation;
those are not installed by the extension.
