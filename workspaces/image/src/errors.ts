// Every way an image can be refused. Readers and edits throw only
// ImageError, with a code a test can assert and a message a user can read;
// anything else escaping is a bug (the fuzz test checks this).

export type ImageErrorCode =
  | "not-an-image" // neither a PNG nor a JPEG
  | "truncated" // the file ends inside a header
  | "damaged" // a header is malformed or its checksum is wrong
  | "unsupported" // a valid file we can't read yet
  | "too-large" // more pixels than the limits allow
  | "invalid-size" // a physical size outside the modelling range
  | "invalid-input"; // a bad argument to an edit

export class ImageError extends Error {
  readonly code: ImageErrorCode;
  constructor(code: ImageErrorCode, message: string) {
    super(message);
    this.name = "ImageError";
    this.code = code;
  }
}
