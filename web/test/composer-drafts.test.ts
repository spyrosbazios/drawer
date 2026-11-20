import type { SessionAttachment } from "@drawer/shared/api";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "@drawer/shared/api";
import { describe, expect, test } from "bun:test";
import { addDraftFiles, clearDraftFiles, draftFiles, pastedName, planFiles, removeDraftFile, retryDraftFile } from "@/components/session/composer-drafts";
import type { Uploader } from "@/components/session/composer-drafts";

const att = (name: string): SessionAttachment => ({ id: `id-${name}`, name, mediaType: "image/png", size: 3, kind: "image", url: `/api/attachments/id-${name}`, filedAs: null });
const file = (name: string, size = 3) => new File([new Uint8Array(size)], name, { type: "image/png" });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("limits", () => {
  test("a file over the size limit is left out, with a short note", () => {
    const plan = planFiles(0, [
      { name: "ok.png", size: 5 },
      { name: "huge.stl", size: MAX_ATTACHMENT_BYTES + 1 },
    ]);
    expect(plan.accepted).toEqual([0]);
    expect(plan.notice).toContain("huge.stl");
  });

  test("only as many as fit under the count limit are taken", () => {
    const many = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}`, size: 1 }));
    const plan = planFiles(MAX_ATTACHMENTS - 2, many);
    expect(plan.accepted).toEqual([0, 1]);
    expect(plan.notice).toContain(String(MAX_ATTACHMENTS));
  });

  test("everything fits: no note", () => {
    expect(planFiles(0, [{ name: "a", size: 1 }]).notice).toBeNull();
  });
});

describe("pasted names", () => {
  test("a clipboard image gets a time-stamped name, a real name stays", () => {
    const at = new Date(2026, 10, 20, 9, 5, 7);
    expect(pastedName({ name: "image.png", type: "image/png" }, at)).toBe("pasted-090507.png");
    expect(pastedName({ name: "caliper.jpg", type: "image/jpeg" }, at)).toBe("caliper.jpg");
  });
});

describe("uploads in a draft", () => {
  test("an upload starts at once, reports progress and ends done", async () => {
    const upload: Uploader = ({ file: f, onProgress }) => {
      onProgress(0.5);
      return Promise.resolve(att(f.name));
    };
    expect(addDraftFiles("done", [file("a.png")], upload)).toBeNull();
    expect(draftFiles("done")[0]?.status).toBe("uploading");
    await settle();
    expect(draftFiles("done")[0]).toMatchObject({ status: "done", attachment: { id: "id-a.png" } });
    clearDraftFiles("done");
    expect(draftFiles("done")).toHaveLength(0);
  });

  test("removing an upload in flight aborts it and drops the file", () => {
    let signal: AbortSignal | undefined;
    const upload: Uploader = ({ signal: s }) => {
      signal = s;
      return new Promise((_resolve, reject) => s.addEventListener("abort", () => reject(new Error("aborted"))));
    };
    addDraftFiles("abort", [file("a.png")], upload);
    const id = draftFiles("abort")[0]?.id ?? "";
    removeDraftFile("abort", id);
    expect(signal?.aborted).toBe(true);
    expect(draftFiles("abort")).toHaveLength(0);
  });

  test("a failed upload shows the error and can be retried", async () => {
    let calls = 0;
    const upload: Uploader = ({ file: f }) => (++calls === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(att(f.name)));
    addDraftFiles("retry", [file("b.png")], upload);
    await settle();
    const failed = draftFiles("retry")[0];
    expect(failed).toMatchObject({ status: "error", error: "offline" });
    retryDraftFile(failed?.id ?? "");
    await settle();
    expect(draftFiles("retry")[0]?.status).toBe("done");
    clearDraftFiles("retry");
  });
});
