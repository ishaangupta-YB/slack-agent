import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Skill {
  name: string;
  content: string;
}

const SKILLS_DIR = "./skills";

function loadSkillsFromDisk(): Skill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    skills.push({
      name: entry.name,
      content: readFileSync(path, "utf-8"),
    });
  }
  return skills;
}

let skillsCache: Skill[] = loadSkillsFromDisk();

export function loadSkills(): Skill[] {
  return skillsCache;
}

export interface ReloadSkillsResult {
  skills: Skill[];
  count: number;
  names: string[];
}

export function reloadSkills(): ReloadSkillsResult {
  skillsCache = loadSkillsFromDisk();
  return {
    skills: skillsCache,
    count: skillsCache.length,
    names: skillsCache.map((s) => s.name),
  };
}

export function buildSkillPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  return (
    "\n\n## Available Skills\n\n" +
    skills
      .map((s) => `### ${s.name}\n${s.content}`)
      .join("\n\n")
  );
}
