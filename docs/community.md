# Community library: open questions

A design note, not a plan. The Community page in the app is a placeholder
until these are answered with the owner (roadmap item C1).

What it is: people share what they make (a whole Panosolid project with its
editable timeline and every workspace's data, or a plain mesh) and anyone
can download it, open it in any workspace and remix it. Everything is free:
no paid models and no payments, ever.

Open questions:

1. Hosting and running costs. Free for users is not free to run: storage,
   bandwidth, search, thumbnails, backups and moderation all cost money or
   time once people use it. Decide before building anything:
   - Where it lives. Options, cheapest first: files kept in a public Git
     repository or release assets (free, size limits, no private data);
     an index we host that only links to files people host themselves
     (cheap, but links rot); object storage behind a CDN (costs grow with
     downloads); peer-to-peer or torrent-style distribution.
   - Who pays, and how it keeps running when the owner is busy: donations,
     a sponsor or grant, an institution, or hard limits that keep it within
     free tiers. No paid content or payments for users either way.
   - Limits that cap the bill: upload size, uploads per account per day,
     download rate limits, deleting abandoned uploads.
   - What happens if the money or the maintainer runs out: an export of
     everything so the library can move or be mirrored.
2. Accounts. Sign-in method; whether downloading needs an account (ideally
   not); what profile data we keep (as little as possible).
3. Uploads. Size limits; which file kinds (Panosolid project, STL, 3MF);
   thumbnails generated in the browser or on the server; virus and malformed
   file checks, since a project file is parsed by the kernel.
4. Licences. Which free licences to offer (for example CC0, CC BY, CC BY-SA)
   and how attribution shows on remixes. Whether to allow "non-commercial"
   licences, given that downloads are free but people may sell prints.
5. Moderation and abuse. Reporting, review, and rules for weapons and other
   harmful models. A free file host attracts abuse, so plan for: pirated
   models (copyright takedown process, and the legal duties of a host in
   the owner's country); illegal or malicious files (only accept file kinds
   the kernel parses, strip anything else, scan uploads); spam accounts;
   storing unrelated files disguised as models. Who moderates, how fast,
   and what is automatic.
6. Search. Tags, categories, full-text search, and ranking without paid
   placement.
7. Remixes. How a remix records its original (project ID and version), and
   what happens when the original is deleted.
8. Privacy and age. Students use this (the owner is one); what that means
   for accounts, contact between users and stored data.
9. Versions. Whether a shared project can be updated, and whether people who
   downloaded it are told.
