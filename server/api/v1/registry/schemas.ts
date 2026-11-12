import { z } from "zod";
import { CursorQuerySchema, PageInfoSchema } from "@shared/contracts/common";
import { OrganizationSchema, ProgramCardSchema } from "@shared/contracts/registry";
import { OpportunityTypeSlugSchema } from "@shared/taxonomy";

/**
 * Response shapes for the two public reads the route map does not list yet: an Organization with
 * its programs, and an opportunity-type hub. They follow the contracts' conventions (strict,
 * paginated, release-stamped) so they can move into shared/contracts/api.ts unchanged.
 */

export const OrganizationResponseSchema = z
  .object({
    organization: OrganizationSchema,
    programs: z.array(ProgramCardSchema),
    release: z.number().int().nonnegative(),
  })
  .strict();
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

export const TypeHubQuerySchema = CursorQuerySchema;

export const TypeHubResponseSchema = z
  .object({
    type: z
      .object({
        slug: OpportunityTypeSlugSchema,
        label: z.string(),
        group: z.string(),
        inScope: z.boolean(),
        programCount: z.number().int().nonnegative(),
      })
      .strict(),
    items: z.array(ProgramCardSchema),
    page: PageInfoSchema,
    release: z.number().int().nonnegative(),
  })
  .strict();
export type TypeHubResponse = z.infer<typeof TypeHubResponseSchema>;
