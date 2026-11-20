import type { CreateProjectBody, PatchProjectBody } from "@drawer/shared/api";
import { keepPreviousData, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createProject, deleteProject, getOverview, getProject, listProjects, patchProject } from "@/services/projects";

export const projectKeys = {
  list: () => ["projects"] as const,
  detail: (slug: string) => ["project", slug] as const,
  overview: (slug: string) => ["overview", slug] as const,
};

export const projectsQuery = () => queryOptions({ queryKey: projectKeys.list(), queryFn: listProjects });
export const projectQuery = (slug: string) => queryOptions({ queryKey: projectKeys.detail(slug), queryFn: () => getProject(slug) });

/** What the outline draws: brief, parts, assembly, references, notes and the library. */
export const overviewQuery = (slug: string) => queryOptions({ queryKey: projectKeys.overview(slug), queryFn: () => getOverview(slug) });

export const useProjects = () => useQuery({ ...projectsQuery(), placeholderData: keepPreviousData });
export const useProject = (slug: string) => useQuery(projectQuery(slug));
export const useOverview = (slug: string) => useQuery(overviewQuery(slug));

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectBody) => createProject(body),
    onSuccess: (project) => {
      qc.setQueryData(projectKeys.detail(project.slug), project);
      void qc.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}

export function usePatchProject(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchProjectBody) => patchProject(slug, body),
    onSuccess: (project) => {
      qc.setQueryData(projectKeys.detail(slug), project);
      void qc.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (slug: string) => deleteProject(slug),
    onSuccess: (_void, slug) => {
      qc.removeQueries({ queryKey: projectKeys.detail(slug) });
      void qc.invalidateQueries({ queryKey: projectKeys.list() });
    },
  });
}
