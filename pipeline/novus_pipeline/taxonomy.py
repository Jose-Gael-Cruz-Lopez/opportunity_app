"""Taxonomy values the pipeline needs in Python, mirrored from shared/taxonomy (drift-tested)."""

from __future__ import annotations

# shared/taxonomy/opportunity-types.ts, in ordinal order.
OPPORTUNITY_TYPE_SLUGS: tuple[str, ...] = (
    "summer_internship", "off_cycle_internship", "new_grad_rotational", "early_career_exposure",
    "uk_spring_week", "sprinternship", "externship_shadowing", "micro_internship",
    "virtual_job_simulation", "apprenticeship", "undergraduate_fellowship", "graduate_fellowship",
    "national_scholarship", "private_scholarship", "institutional_scholarship", "service_scholarship",
    "grant", "research_program", "pipeline_program", "leadership_cohort", "affinity_community",
    "conference_travel", "competition", "open_source_mentorship", "study_abroad_language",
    "government_service", "service_year", "accelerator_founder", "campus_ambassador", "campus_job",
    "paid_training", "gap_year", "high_school_pathway",
)  # fmt: skip
