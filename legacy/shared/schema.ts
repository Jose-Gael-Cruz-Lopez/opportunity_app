import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Users
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  displayName: text("display_name"),
  email: text("email"),
  major: text("major"),
  year: text("year"),
  university: text("university"),
  avatarUrl: text("avatar_url"),
  readinessScore: integer("readiness_score"),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// Opportunities
export const opportunities = sqliteTable("opportunities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  organization: text("organization").notNull(),
  category: text("category").notNull(), // internship, scholarship, research, fellowship, competition
  description: text("description"),
  location: text("location"),
  locationType: text("location_type"), // onsite, remote, hybrid
  deadline: text("deadline"),
  salary: text("salary"),
  tags: text("tags"), // JSON array stored as text
  logoUrl: text("logo_url"),
  applicantCount: integer("applicant_count"),
  matchScore: integer("match_score"),
  isFeatured: integer("is_featured", { mode: "boolean" }),
});

export const insertOpportunitySchema = createInsertSchema(opportunities).omit({
  id: true,
});

export type InsertOpportunity = z.infer<typeof insertOpportunitySchema>;
export type Opportunity = typeof opportunities.$inferSelect;

// Community Stories
export const stories = sqliteTable("stories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorName: text("author_name").notNull(),
  authorAvatar: text("author_avatar"),
  university: text("university"),
  title: text("title").notNull(),
  content: text("content").notNull(),
  opportunityTitle: text("opportunity_title"),
  category: text("category"), // got-in, advice, experience
  likes: integer("likes"),
});

export const insertStorySchema = createInsertSchema(stories).omit({
  id: true,
});

export type InsertStory = z.infer<typeof insertStorySchema>;
export type Story = typeof stories.$inferSelect;

// Roadmap milestones
export const milestones = sqliteTable("milestones", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id"),
  year: text("year").notNull(), // freshman, sophomore, junior, senior
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"), // academic, professional, extracurricular
  isCompleted: integer("is_completed", { mode: "boolean" }),
  order: integer("order"),
});

export const insertMilestoneSchema = createInsertSchema(milestones).omit({
  id: true,
});

export type InsertMilestone = z.infer<typeof insertMilestoneSchema>;
export type Milestone = typeof milestones.$inferSelect;
