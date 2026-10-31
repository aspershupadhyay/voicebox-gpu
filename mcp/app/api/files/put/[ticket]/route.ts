// Step 2 of saving a file (lib/inbox.ts), through our own domain: PUT the file's raw bytes here
// (`curl -sS -T <file> "<put_url>"`, or `--data-binary @<file>`), and they stream into R2 through the Worker's binding,
// byte for byte: no Base64, no conversion. For clients that can't reach the R2 hostname the presigned upload_url uses.
// Up to 95 MB (Cloudflare's request cap); bigger files go to upload_url. The signed ticket in the path is the claim:
// it names one file (key, name, type, and its size when given), works once and expires in an hour, like upload_url
// itself. It can only write that one file; nothing is read or listed. Answers a receipt: bytes and SHA-256.
import { putUpload, UploadError } from "@/lib/inbox";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function PUT(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  try {
    return Response.json(await putUpload(decodeURIComponent((await params).ticket), req));
  } catch (e) {
    const status = e instanceof UploadError ? e.status : /ticket/.test((e as Error).message) ? 403 : 500;
    return Response.json({ error: (e as Error).message }, { status });
  }
}
