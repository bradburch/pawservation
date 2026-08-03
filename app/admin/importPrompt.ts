/**
 * The prompt a sitter copies and pastes into ChatGPT or Claude, along with their own client list,
 * so the AI does the reformatting into the exact CSV shape `POST /:slug/admin/customers/import`
 * expects (`server/routes/admin.ts`) instead of the sitter reformatting a spreadsheet by hand.
 *
 * The pet-type list is INTERPOLATED per tenant at copy-time — never a static placeholder — because
 * `Pet Type` must match this tenant's own registry, and it must match the registry's SLUG, not the
 * label a sitter sees on screen: `server/lib/services.ts`'s `slugifyServiceLabel` stores "Guinea
 * Pig" as `guinea-pig`, and the importer's `knownPetTypes` set (routes/admin.ts) is built from that
 * same slug column. A prompt that only handed the AI the human label ("Guinea Pig") would have it
 * write the label back verbatim, which the importer would then reject as an unknown pet type — so
 * every entry below spells out the literal code to write, not just the name a client would read.
 */

export type ImportPetType = { petType: string; label: string };

/** Exact header the example file ships (`public/clients-import-example.csv`) — content the parser
 *  itself never checks (it unconditionally drops row 1), but matching it keeps what the AI produces
 *  looking like the file a sitter already knows how to open and check in a spreadsheet. */
const HEADER_ROW = 'Client Email,Client Name,Pet Name,Pet Type,Co-owner Emails';

export function buildClientImportPrompt(petTypes: ImportPetType[]): string {
  const petTypeLines =
    petTypes.length > 0
      ? petTypes.map((pt) => `- ${pt.label} → write exactly: ${pt.petType}`).join('\n')
      : '- (no pet types are set up yet — add one in the Pet types section first)';

  return `You're helping me reformat my pet-sitting client list into a CSV file for an import tool. Below this prompt, I'll paste my client information — it might be a table, a plain list, or notes, with columns in any order, and it may include extra information I don't need to keep (phone numbers, addresses, notes, etc.).

Read everything I paste below and output ONLY a CSV file in the exact format described here. Do not add any explanation, comments, or code fences (no \`\`\`) before or after it — just the raw CSV text, ready for me to copy straight into a file.

FORMAT — exactly 5 columns, always in this order: Client Email, Client Name, Pet Name, Pet Type, Co-owner Emails.

RULES — follow every one of these exactly, they matter for the file to import correctly:

1. The very first line of your output must be exactly this header row (the app always throws away line 1 no matter what's actually in it, so if you skip the header, my first real client is silently lost):
${HEADER_ROW}
2. One row per PET, not per client. If a client has 2 pets, write 2 rows for them.
3. Repeat that client's email and name on every one of their rows, even when they have several pets — never leave the name blank on a later row.
4. Pet Type must be one of the exact codes below, and nothing else (matching ignores capitalization, but not spaces or spelling):
${petTypeLines}
   If you can't confidently tell what kind of animal a pet is, leave the Pet Type cell blank rather than guessing — the app will flag just that one row for me to fix by hand instead of silently importing the wrong species.
5. Every client needs a real email address. If you can't find or reasonably infer one for someone, leave that person and their pets out of the CSV entirely — never invent an email address.
6. Two people sharing a pet (like a couple)? Put the other person's email in the Co-owner Emails column, on the row(s) for the pet(s) they share together — up to 5 co-owner emails in that one cell, separated by a semicolon (;), never a comma (this is a comma-separated file, so a comma there would split into an extra column and break the row). Also give that co-owner their own row somewhere in the file, with their own email and name filled in and Pet Name / Pet Type left blank.
7. Leave the Co-owner Emails column blank for everyone else.
8. If a piece of text itself contains a comma (for example a name like "Smith, Jr."), wrap that whole field in double quotes.
9. Don't add blank lines before the header or between rows.
10. Never output more than 500 data rows (not counting the header) — the tool rejects the WHOLE file if you go even one row over, not just the extra rows. If I pasted more clients than that, do the first 500 and stop; I'll import the rest as a second batch.
11. Only include people and pets that are actually named in what I paste below — don't invent, guess at, or duplicate anyone.

Here is my client list:
[PASTE YOUR CLIENT LIST BELOW THIS LINE]
`;
}
