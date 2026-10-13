import { advance } from "./workflow.ts";
import type { Project } from "./workflow.ts";
let project: Project = { id: "example", stage: "planning", evidence: {
  specificationApproved: true, acceptanceCriteriaDefined: true,
  implementationRecorded: true, reviewPassed: true, acceptancePassed: true,
  deployedUrl: "https://example.com", smokePassed: true
}};
const stages = [project.stage];
while (project.stage !== "delivered") {
  project = advance(project);
  stages.push(project.stage);
}
console.log("Simulated workflow only (no agents or deployment):", stages.join(" -> "));
