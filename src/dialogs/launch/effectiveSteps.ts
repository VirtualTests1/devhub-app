import type { LaunchStep, RepoDetail } from "../../types";

/** The step list a marker effectively represents (mirrors the Rust helper). */
export function effectiveStepsOf(d: RepoDetail): LaunchStep[] {
  const l = d.launch;
  if (!l) return [];
  if (l.steps && l.steps.length > 0) return l.steps;
  if (!l.command.trim()) return [];
  return [{ name: "启动", command: l.command, cwd: l.cwd, parallel: false }];
}

/**
 * Preset step lists.
 *
 * The first two cover the shape almost every repository needs - install
 * dependencies, then run - and are deliberately editable afterwards: a template
 * is a starting point, not a decision. `pnpm` is offered alongside `npm` because
 * the launcher already picks the manager from the lockfile elsewhere.
 */
export const STEP_TEMPLATES: { id: string; label: string; steps: LaunchStep[] }[] = [
  {
    id: "node-npm",
    label: "Node · npm",
    steps: [
      { name: "安装依赖", command: "npm install", cwd: "", parallel: false },
      { name: "启动", command: "npm run dev", cwd: "", parallel: false },
    ],
  },
  {
    id: "node-pnpm",
    label: "Node · pnpm",
    steps: [
      { name: "安装依赖", command: "pnpm install", cwd: "", parallel: false },
      { name: "启动", command: "pnpm dev", cwd: "", parallel: false },
    ],
  },
  {
    id: "python",
    label: "Python",
    steps: [
      { name: "安装依赖", command: "pip install -r requirements.txt", cwd: "", parallel: false },
      { name: "启动", command: "python main.py", cwd: "", parallel: false },
    ],
  },
  {
    id: "docker",
    label: "Docker Compose",
    steps: [{ name: "启动容器", command: "docker compose up", cwd: "", parallel: false }],
  },
];
