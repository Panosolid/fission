// @fission/community: the community library. PLACEHOLDER: nothing here works yet.
//
// People share what they have made and anyone can download it, always for
// free: there is no paid content and no payments anywhere. A shared Fission
// project opens with its editable timeline (and its render scenes, studies,
// toolpaths, laser jobs and print plates), not just a mesh; remixes link
// back to the original. It needs a server (accounts, uploads, moderation,
// licences, search); see docs/community.md for the open questions.

import type { WorkspaceId } from "@fission/core";

/** DRAFT: one shared item in the library. */
export interface SharedItem {
  id: string;
  title: string;
  author: string;
  /** A free licence chosen by the author, e.g. "CC-BY-4.0". */
  licence: string;
  /** A whole Fission project (editable) or a plain mesh. */
  kind: "project" | "mesh";
  /** Which workspaces have content in it (design, render scenes, print plates…). */
  contains: WorkspaceId[];
  /** The item this one remixes, if any. */
  remixOf?: string;
}

export interface Library {
  search(query: string): Promise<SharedItem[]>;
  /** Downloads an item into a new local project. Always free. */
  download(id: string): Promise<void>;
  /** Shares the current project (or a mesh of it). */
  publish(item: Omit<SharedItem, "id" | "author">): Promise<SharedItem>;
}

/** The community library. Not implemented yet. */
export function communityLibrary(): Library {
  throw new Error("not implemented");
}

/** What the Community page says until the library exists. */
export const communityPage = {
  title: "Community",
  summary: "Share what you make, and download what others share. Everything here is free: no paid models, no payments.",
  plans: [
    "Publish a project or a mesh with a free licence of your choice",
    "Search and browse what others have shared",
    "Download into a new project: a Fission project opens with its editable timeline, not just a mesh",
    "Open a download in any workspace (Design, Render, Slice…) since it is all one project",
    "Remix: your copy links back to the original and credits its author",
  ],
  startsAfter: "after CAD step 33 (the timeline), with STL/3MF export (73) for meshes; it needs a server first (see docs/community.md)",
};
