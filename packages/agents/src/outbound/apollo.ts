import { serverEnv } from "@copywriting-bot/shared/env";

/**
 * Apollo prospect search wrapper.
 *
 * MVP usage: source 50-100 B2B SaaS founders / heads of growth per day,
 * matching our ICP filters. Phase 2 may swap to Clay for richer signals.
 */

export type ApolloProspect = {
  id: string;
  first_name: string;
  last_name: string;
  title: string;
  email: string | null;
  organization: {
    name: string;
    primary_domain: string | null;
    estimated_num_employees: number | null;
    industry: string | null;
  };
};

export type ApolloSearchFilters = {
  titles?: string[]; // e.g., ["Founder", "Head of Growth"]
  industries?: string[]; // e.g., ["SaaS", "Software"]
  employee_min?: number;
  employee_max?: number;
  page?: number;
  per_page?: number;
};

export async function searchProspects(
  filters: ApolloSearchFilters,
): Promise<{ prospects: ApolloProspect[]; total: number }> {
  const env = serverEnv();
  if (!env.APOLLO_API_KEY) throw new Error("APOLLO_API_KEY is not configured");

  const body = {
    api_key: env.APOLLO_API_KEY,
    person_titles: filters.titles ?? ["Founder", "Co-Founder", "Head of Growth"],
    organization_industry_tag_ids: filters.industries,
    organization_num_employees_ranges:
      filters.employee_min && filters.employee_max
        ? [`${filters.employee_min},${filters.employee_max}`]
        : ["10,500"],
    page: filters.page ?? 1,
    per_page: filters.per_page ?? 25,
  };

  const res = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Apollo search returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  const json = (await res.json()) as {
    people: Array<{
      id: string;
      first_name: string;
      last_name: string;
      title: string;
      email: string | null;
      organization: {
        name: string;
        primary_domain: string | null;
        estimated_num_employees: number | null;
        industry: string | null;
      } | null;
    }>;
    pagination?: { total_entries: number };
  };

  return {
    total: json.pagination?.total_entries ?? json.people.length,
    prospects: json.people
      .filter((p) => p.organization)
      .map((p) => ({
        id: p.id,
        first_name: p.first_name,
        last_name: p.last_name,
        title: p.title,
        email: p.email,
        organization: p.organization!,
      })),
  };
}
