import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { lifecycleDirectory } from "../src/server/lifecycle-ledger";
import { HttpError } from "../src/server/errors";

// Pure filesystem tests: no PostgreSQL connection, server, credentials or real archives.
test("private lifecycle directory rejects static destinations and their parent aliases", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "catletters-private-path-"));
  const before = process.env.E4_LIFECYCLE_DIR;
  const rejects = (path: string) => {
    process.env.E4_LIFECYCLE_DIR = path;
    assert.throws(
      () => lifecycleDirectory(),
      (error: unknown) => error instanceof HttpError && error.status === 503,
    );
  };
  try {
    await t.test(
      "ordinary existing and not-yet-created private directories are accepted",
      () => {
        const privateRoot = join(root, "private-data");
        mkdirSync(privateRoot);
        process.env.E4_LIFECYCLE_DIR = privateRoot;
        assert.equal(lifecycleDirectory(), realpathSync(privateRoot));
        process.env.E4_LIFECYCLE_DIR = join(privateRoot, "new-store");
        const unopened = lifecycleDirectory();
        assert.equal(
          realpathSync(dirname(unopened)),
          realpathSync(privateRoot),
        );
        assert.equal(basename(unopened), "new-store");
      },
    );
    for (const segment of ["public", "pages-dist", ".git", ".next/static"]) {
      await t.test(
        `rejects direct ${segment} directory before it is created`,
        () => {
          rejects(join(root, segment, "private-data"));
        },
      );
    }
    for (const segment of ["public", ".next/static"]) {
      await t.test(
        `rejects parent alias into ${segment} for existing and new child directories`,
        () => {
          const destination = join(root, segment);
          mkdirSync(join(destination, "existing-store"), { recursive: true });
          const alias = join(
            root,
            segment === "public" ? "public-alias" : "static-alias",
          );
          symlinkSync(destination, alias, "dir");
          rejects(join(alias, "existing-store"));
          rejects(join(alias, "not-created-yet", "private-data"));
        },
      );
    }
    await t.test("rejects a symlink as the private directory itself", () => {
      const target = join(root, "real-private");
      const alias = join(root, "private-link");
      mkdirSync(target);
      symlinkSync(target, alias, "dir");
      rejects(alias);
    });
  } finally {
    if (before === undefined) delete process.env.E4_LIFECYCLE_DIR;
    else process.env.E4_LIFECYCLE_DIR = before;
    rmSync(root, { recursive: true, force: true });
  }
});
