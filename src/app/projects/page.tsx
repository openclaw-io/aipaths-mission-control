import { ProjectsClient } from "@/components/projects/ProjectsClient";
import { getProjectDetail, listProjectGalleryCards, type ProjectDetailPayload } from "@/lib/projects/read-model";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const projects = await listProjectGalleryCards();
  const detailsEntries = await Promise.all(projects.map(async (project) => [project.id, await getProjectDetail(project.id)] as const));
  const projectDetails: Record<string, ProjectDetailPayload> = Object.fromEntries(
    detailsEntries.filter((entry): entry is readonly [string, ProjectDetailPayload] => entry[1] !== null)
  );

  return (
    <div>
      <h1 className="text-2xl font-bold text-white">📐 Projects</h1>
      <p className="mt-1 text-sm text-gray-500">
        Planning, approvals, and execution readiness for active initiatives
      </p>
      <div className="mt-6">
        <ProjectsClient projects={projects} projectDetails={projectDetails} />
      </div>
    </div>
  );
}
