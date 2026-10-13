export type Stage = "planning" | "ready" | "building" | "reviewing" | "testing" | "deploying" | "delivered";
export interface Project {
  id: string;
  stage: Stage;
  evidence: {
    specificationApproved?: boolean;
    acceptanceCriteriaDefined?: boolean;
    implementationRecorded?: boolean;
    reviewPassed?: boolean;
    acceptancePassed?: boolean;
    deployedUrl?: string;
    smokePassed?: boolean;
  };
}
const next: Partial<Record<Stage, Stage>> = {
  planning: "ready", ready: "building", building: "reviewing",
  reviewing: "testing", testing: "deploying", deploying: "delivered"
};
// Pure demonstration only: production gates must consume trusted tool results.
export function advance(project: Project): Project {
  const e = project.evidence;
  const permitted: Record<Stage, boolean> = {
    planning: e.specificationApproved === true && e.acceptanceCriteriaDefined === true,
    ready: true,
    building: e.implementationRecorded === true,
    reviewing: e.reviewPassed === true,
    testing: e.acceptancePassed === true,
    deploying: Boolean(e.deployedUrl) && e.smokePassed === true,
    delivered: false
  };
  const target = next[project.stage];
  if (!target || !permitted[project.stage]) throw new Error("Required evidence missing or workflow already complete");
  return { ...project, stage: target };
}
