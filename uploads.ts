// ---------------------------------------------------------------------------
// Barttech shared file-upload guards for routes that accept a user-supplied file
// (website security standard — upload handling). The rule this module encodes:
//
//   NEVER trust the client-declared MIME type (`file.type`) or the filename
//   extension. Both are attacker-controlled strings. A `.png` called
//   `shell.php.png` with `Content-Type: image/png` is still whatever its BYTES
//   say it is. Sniff the magic bytes and decide from those.
//
// The declared type is only ever used to RECONCILE an ambiguous sniff (see the
// OOXML/ZIP note in `validateUpload`) — never as the source of truth.
//
// Node-runtime only, in line with the rest of web-core. Typed against the
// web-standard `File`/`Blob` so web-core stays framework-agnostic (a file pulled
// off a Next.js `await req.formData()` IS a `File`). Import as
// `@/web-core/uploads`.
// ---------------------------------------------------------------------------

/**
 * Named size ceilings, in bytes. These are CEILINGS, not targets — a route
 * should pick the tightest preset that fits its purpose (an avatar endpoint has
 * no business accepting 100 MB), or pass its own smaller number. Raising a
 * preset raises it for every consumer, so prefer a local override.
 */
export const UPLOAD_LIMITS = {
  /** General imagery (blog covers, product shots). */
  image: 5 * 1024 * 1024,
  /** PDFs and office documents. */
  document: 10 * 1024 * 1024,
  /** Profile pictures — deliberately the tightest preset. */
  avatar: 2 * 1024 * 1024,
  /** Video. Only for routes that genuinely stream video; almost nothing should. */
  video: 100 * 1024 * 1024,
} as const;

/** Image types we are willing to accept and re-serve. No SVG — it executes script. */
export const IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
] as const;

/**
 * Document types. The two OOXML entries (docx/xlsx) are ZIP containers on disk,
 * so they sniff as `application/zip` — see the reconciliation note in
 * `validateUpload`.
 */
export const DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** The OOXML types that legitimately arrive as a sniffed `application/zip`. */
const OOXML_MIME_TYPES = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** True if `bytes` matches `sig` (a byte sequence) starting at `offset`. */
function matchesAt(bytes: Uint8Array, offset: number, sig: readonly number[]): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

/** True if the ASCII text `text` appears at `offset`. */
function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  const sig = Array.from(text, (c) => c.charCodeAt(0));
  return matchesAt(bytes, offset, sig);
}

/**
 * Detect a file's real MIME type from its leading magic bytes. Returns null when
 * nothing matches — an unrecognised file is a REJECT, never a "probably fine".
 *
 * Detects: JPEG, PNG, GIF (87a/89a), WebP, AVIF, PDF, and the generic ZIP
 * container. Note that docx/xlsx are ZIP containers, so a real docx sniffs as
 * `application/zip` — that is the expected, correct result, and the CALLER must
 * reconcile it against the declared type (`validateUpload` does this for you).
 */
export function sniffMimeType(bytes: Uint8Array): string | null {
  // JPEG — FF D8 FF
  if (matchesAt(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (matchesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // GIF — "GIF87a" / "GIF89a"
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";

  // WebP — RIFF container: "RIFF" at 0..3, 4-byte length, "WEBP" at 8..11.
  // Both halves must match; "RIFF" alone is also AVI/WAV.
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";

  // AVIF — ISO-BMFF: 4-byte box size, "ftyp" at 4..7, major brand at 8..11.
  if (asciiAt(bytes, 4, "ftyp") && (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))) {
    return "image/avif";
  }

  // PDF — "%PDF-"
  if (asciiAt(bytes, 0, "%PDF-")) return "application/pdf";

  // ZIP local file header — PK\x03\x04. docx/xlsx/pptx land here.
  if (matchesAt(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";

  return null;
}

/**
 * Make a user-supplied filename safe to use as a storage key. Strips any
 * directory component (`../../etc/passwd` → `passwd`), collapses everything
 * outside `[a-zA-Z0-9._-]` to `_`, strips leading dots (no `.htaccess`-style
 * hidden files), and caps the length at 100 chars while preserving the
 * extension. Returns `"file"` if nothing survives.
 *
 * This is the path-traversal guard for object-storage keys — always run the
 * original name through it before building an R2/S3/Supabase key.
 */
export function safeUploadFilename(name: string): string {
  // Directory components: take whatever follows the last / or \.
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";

  let cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "");
  if (!cleaned) return "file";

  if (cleaned.length > 100) {
    const dot = cleaned.lastIndexOf(".");
    // Only treat a trailing segment as an extension if it's short and real.
    const ext = dot > 0 && cleaned.length - dot <= 11 ? cleaned.slice(dot) : "";
    cleaned = cleaned.slice(0, 100 - ext.length) + ext;
  }

  // A name that was nothing but dots/slashes can end up empty after cleaning.
  return cleaned.replace(/^\.+/, "") || "file";
}

/**
 * Alias of `safeUploadFilename` for call sites sanitising something that isn't
 * an uploaded file's original name — a DB id, a constructed filename segment
 * — where "upload" reads oddly. Same function, same guarantees; this exists
 * purely for readability, not as a second implementation. Always import and
 * fix `safeUploadFilename` itself; this alias picks up any change for free.
 */
export const sanitizeStorageSegment = safeUploadFilename;

/** Lowercase extension without the dot (`""` when the name has none). */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export interface ValidateUploadOptions {
  /** Hard byte ceiling — use a `UPLOAD_LIMITS` preset or something tighter. */
  maxBytes: number;
  /** The MIME types this route accepts, e.g. `IMAGE_MIME_TYPES`. */
  allowedMimeTypes: readonly string[];
  /** Optional extension allowlist (lowercase, no dot), e.g. `["jpg","jpeg","png"]`. */
  allowedExtensions?: readonly string[];
}

export type ValidateUploadResult =
  | {
      ok: true;
      /** The RECONCILED real type — sniffed, not the client's claim. */
      mimeType: string;
      /** Lowercase extension without the dot. */
      extension: string;
      /** The sanitised filename, safe to use as a storage key. */
      filename: string;
      /** The file's bytes, already read — reuse these, don't re-read the File. */
      bytes: Uint8Array;
    }
  | { ok: false; error: string; status: number };

/**
 * The single entry point for validating an uploaded file server-side. Checks, in
 * order: size ceiling → real (sniffed) MIME type → allowlist → extension.
 *
 * Never throws — any unexpected failure (an unreadable stream, a truncated
 * upload) comes back as `{ ok: false }` so the route returns a clean status code
 * instead of a 500.
 *
 * ```ts
 * const form = await req.formData();
 * const result = await validateUpload(form.get("file") as File, {
 *   maxBytes: UPLOAD_LIMITS.image,
 *   allowedMimeTypes: IMAGE_MIME_TYPES,
 * });
 * if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
 * ```
 */
export async function validateUpload(
  file: File,
  opts: ValidateUploadOptions
): Promise<ValidateUploadResult> {
  try {
    if (!file || typeof file.arrayBuffer !== "function") {
      return { ok: false, error: "No file provided", status: 400 };
    }

    // 1. Size first — cheapest check, and it avoids buffering a huge payload.
    if (file.size > opts.maxBytes) {
      // Sub-megabyte caps read as "0 MB" — fall back to KB so the message is useful.
      const limit =
        opts.maxBytes >= 1024 * 1024
          ? `${Math.round((opts.maxBytes / (1024 * 1024)) * 10) / 10} MB`
          : `${Math.round(opts.maxBytes / 1024)} KB`;
      return { ok: false, error: `File exceeds the ${limit} limit`, status: 413 };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());

    // 2. What is it REALLY? The declared file.type is not consulted here.
    const sniffed = sniffMimeType(bytes);
    if (!sniffed) {
      return { ok: false, error: "Unrecognised or unsupported file type", status: 415 };
    }

    // 3. Allowlist. One reconciliation is permitted: docx/xlsx are ZIP
    //    containers, so a genuine one sniffs as `application/zip`. We accept
    //    that ONLY when the client declared a specific OOXML type AND that
    //    exact type is on the route's allowlist. The declared type never
    //    widens what is allowed — it only disambiguates a sniff we already
    //    matched, so a renamed .zip payload still can't get through a route
    //    that doesn't accept OOXML.
    let mimeType = sniffed;
    if (!opts.allowedMimeTypes.includes(sniffed)) {
      const declared = typeof file.type === "string" ? file.type : "";
      const isOoxmlZip =
        sniffed === "application/zip" &&
        (OOXML_MIME_TYPES as readonly string[]).includes(declared) &&
        opts.allowedMimeTypes.includes(declared);

      if (!isOoxmlZip) {
        return { ok: false, error: "Unrecognised or unsupported file type", status: 415 };
      }
      mimeType = declared;
    }

    // 4. Extension allowlist (optional) — checked against the SANITISED name.
    const filename = safeUploadFilename(file.name ?? "");
    const extension = extensionOf(filename);
    if (opts.allowedExtensions && !opts.allowedExtensions.includes(extension)) {
      return { ok: false, error: "Unrecognised or unsupported file type", status: 415 };
    }

    return { ok: true, mimeType, extension, filename, bytes };
  } catch {
    return { ok: false, error: "Could not read the uploaded file", status: 400 };
  }
}
