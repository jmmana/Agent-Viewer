import type { Agent } from '../types/agent';

interface Pose {
  x: number;
  y: number;
  sourceX: number;
  sourceY: number;
  facing: Agent['facing'];
}

/** Presentation positions are deliberately separate from React's simulation state. */
export class OfficeMotion {
  private poses = new Map<string, Pose>();

  update(agents: readonly Agent[], deltaMs: number, reducedMotion = false): Agent[] {
    const alive = new Set(agents.map((agent) => agent.id));
    for (const id of this.poses.keys()) if (!alive.has(id)) this.poses.delete(id);

    return agents.map((agent) => {
      let pose = this.poses.get(agent.id);
      if (!pose || pose.sourceX !== agent.x || pose.sourceY !== agent.y || !agent.isWalking) {
        pose = { x: agent.x, y: agent.y, sourceX: agent.x, sourceY: agent.y, facing: agent.facing };
      }

      if (agent.isWalking) {
        const dx = agent.targetX - pose.x;
        const dy = agent.targetY - pose.y;
        const distance = Math.hypot(dx, dy);
        // 3 tiles/second at every refresh rate; no huge jump after a hidden tab resumes.
        const step = reducedMotion ? distance : Math.min(Math.max(deltaMs, 0), 50) * 0.003;
        if (distance > 0) {
          const amount = Math.min(step, distance) / distance;
          pose.x += dx * amount;
          pose.y += dy * amount;
          pose.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'SE' : 'NW') : (dy > 0 ? 'SW' : 'NE');
        }
      }
      this.poses.set(agent.id, pose);
      return { ...agent, x: pose.x, y: pose.y, facing: pose.facing,
        isWalking: agent.isWalking && Math.hypot(agent.targetX - pose.x, agent.targetY - pose.y) > 0.001 };
    });
  }
}
