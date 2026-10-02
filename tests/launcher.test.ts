import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("launcher reports failures without extra modal windows or balloon notifications", async () => {
  for (const file of ["Program.cs", "ReviewForm.cs"]) {
    const source = await readFile(new URL(`../apps/launcher/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\bMessageBox\s*\.|\.ShowBalloonTip\s*\(/, file);
  }
});
