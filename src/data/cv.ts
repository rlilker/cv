/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  CV DATA — the single source of truth for the whole site.
 * ─────────────────────────────────────────────────────────────────────────────
 *  All content lives in `cv.json`. This module only adds types and does a
 *  little normalisation, so no component ever touches the raw file.
 *
 *  Why JSON rather than inline TypeScript?
 *  --------------------------------------
 *  Because `cv.json` is *the same shape an API would return*. When the content
 *  later moves behind an endpoint, the change is confined to this one file:
 *
 *      // before
 *      import data from './cv.json';
 *      // after  — identical types, identical component tree
 *      const data = await fetch(`${API_BASE}/cv`).then((r) => r.json());
 *
 *  Nothing else in `src/` needs to change. See README → "Going dynamic".
 */

import data from './cv.json';

export interface Role {
  /** Stable anchor id, also used for deep links. */
  id: string;
  title: string;
  company: string;
  /** Free-form type marker shown as a small tag, e.g. "Contract". */
  type?: string;
  start: string;
  end: string;
  /** One-line "what this role was about". */
  summary: string;
  /** Bullet points. Keep them outcome-shaped: what changed, and by how much. */
  highlights: string[];
  /** Notable technologies used in this role. */
  stack?: string[];
}

export interface SkillGroup {
  id: string;
  title: string;
  items: string[];
}

export interface NavSection {
  id: string;
  label: string;
}

export interface Profile {
  name: string;
  firstName: string;
  role: string;
  location: string;
  timezone: string;
  /** Contact routes. No email or telephone — LinkedIn and GitHub only. */
  linkedin: string;
  github: string;
  yearsExperience: number;
  /** Opening copy, and the basis for the page meta description. */
  intro: string[];
}

export const profile: Profile = data.profile;
export const roles: Role[] = data.roles;
export const skillGroups: SkillGroup[] = data.skillGroups;
export const interests: string[] = data.interests;
export const navSections: NavSection[] = data.navSections;

/** Surname only — used to split the hero name across two styled spans. */
export const lastName: string = profile.name.split(' ').slice(1).join(' ');

/** Total number of bullet points rendered in the experience timeline. */
export const totalHighlights: number = roles.reduce((sum, role) => sum + role.highlights.length, 0);

/** A project page linked from the nav and from the CV. */
export interface ProjectLink {
  id: string;
  label: string;
  href: string;
  /** One-liner used in the CV's project strip. */
  blurb: string;
}

export const projectLinks: ProjectLink[] = [
  {
    id: 'family-assistant',
    label: 'Family Assistant',
    href: '/family-assistant',
    blurb: 'A self-hosted pipeline that turns a family’s Gmail into a shared calendar, using a language model running on a Raspberry Pi.',
  },
];

