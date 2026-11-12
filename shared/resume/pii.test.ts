import { describe, expect, it } from "vitest";
import { detectPii, namePatterns, redactPii } from "./pii";
import type { PiiKind } from "./types";

const kinds = (text: string, names: string[] = []): PiiKind[] => detectPii(text, { names }).map((h) => h.kind);
const matches = (text: string, names: string[] = []): string[] => detectPii(text, { names }).map((h) => h.match);

describe("emails", () => {
  it.each([
    "jane.doe@example.com",
    "j_doe+jobs@mail.example.edu",
    "JANE@EXAMPLE.ORG",
    "jane [at] example [dot] edu",
    "jane(at)example.edu",
    "jane at gmail dot com",
    "mailto:jane@example.com",
  ])("finds %s", (email) => {
    expect(kinds(`Contact: ${email} today`)).toContain(email.startsWith("mailto") ? "link" : "email");
  });

  it("reports an email once, not also its domain as a link", () => {
    expect(detectPii("jane.doe@example.com")).toEqual([{ kind: "email", start: 0, end: 20, match: "jane.doe@example.com" }]);
  });
});

describe("phones", () => {
  it.each(["(555) 010-0142", "555-010-0142", "555.010.0142", "555 010 0142", "+1 555 010 0142", "+1-555-010-0142 ext. 12", "+44 20 7946 0123", "5550100142", "Phone: 010-0142"])(
    "finds %s",
    (phone) => {
      expect(kinds(`Call ${phone}.`)).toContain("phone");
    },
  );

  it.each(["2023-2024", "2023 - 2024", "GPA 3.85/4.00", "Ithaca, NY 14850 area", "CS 2110 and MATH 2940", "Raised $12,500,000", "Jun 2025 - Aug 2025", "ISBN 12"])(
    "leaves %s alone",
    (text) => {
      expect(kinds(text).filter((k) => k === "phone")).toEqual([]);
    },
  );
});

describe("links and handles", () => {
  it.each(["https://janedoe.dev/work", "www.janedoe.com", "linkedin.com/in/jane-doe", "github.com/janedoe", "janedoe.github.io", "jane-doe.vercel.app", "@janedoe", "tel:+15550100142"])(
    "finds %s",
    (link) => {
      expect(kinds(`See ${link}`)).toContain("link");
    },
  );

  it("does not take product names for domains", () => {
    expect(kinds("Built with ASP.NET, Socket.io and draw.io; used Node.js and Next.js")).toEqual([]);
  });

  it("trims sentence punctuation off a link", () => {
    expect(matches("Portfolio at janedoe.dev.")).toEqual(["janedoe.dev"]);
  });
});

describe("addresses and identifiers", () => {
  it.each([
    ["742 Evergreen Terrace, Springfield, OR 97477", "address"],
    ["1442 Peachtree Street NE, Apt 5", "address"],
    ["PO Box 123", "address"],
    ["Suite 210", "address"],
    ["Atlanta, GA 30309", "address"],
    ["SSN 123-45-6789", "id"],
    ["Student ID: A12345678", "id"],
    ["NetID: jd123", "id"],
    ["Passport No. X1234567", "id"],
    ["DOB: 04/12/2007", "birthdate"],
    ["Date of birth: March 3, 2007", "birthdate"],
  ] as const)("finds %s", (text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  it.each(["Taught Unit 3 of the algebra course", "Tuned a PID controller for the drone", "Served 2025 Research Assistant Dr. Kim? no", "000-12-3456 is not valid", "666-12-3456", "123-00-4567"])(
    "does not take %s for an address or id",
    (text) => {
      expect(kinds(text).filter((k) => k === "address" || k === "id")).toEqual([]);
    },
  );
});

describe("names", () => {
  it("redacts the full name, initials and surname forms from a seed", () => {
    const text = "Jordan Alvarez-Reyes led the team. Alvarez-Reyes, Jordan. J. Alvarez-Reyes. Reyes presented. JORDAN ALVAREZ-REYES";
    const out = redactPii(text, { names: ["Jordan Alvarez-Reyes"] }).text;
    expect(out).not.toMatch(/Alvarez|Reyes/i);
  });

  it("keeps a first name that is also a word or month on its own", () => {
    const out = redactPii("May Chen applied in May 2025 for the Pell Grant. Grant May helped.", { names: ["May Chen", "Grant May"] }).text;
    expect(out).toContain("in May 2025");
    expect(out).toContain("Pell Grant");
    expect(out).not.toContain("Chen");
  });

  it("matches seeds across accents and case", () => {
    const out = redactPii("Worked with NGUYEN THI MINH ANH and Nguyen Thi Minh Anh", { names: ["Nguyễn Thị Minh Anh"] }).text;
    expect(out).not.toMatch(/nguyen|minh/i);
  });

  it("redacts surnames that are common words only when capitalized", () => {
    const pats = namePatterns("Ava Brown");
    expect(pats.some((p) => p.exactCase)).toBe(true);
    const out = redactPii("Ava Brown cooked brown rice. Brown won.", { names: ["Ava Brown"] }).text;
    expect(out).toContain("brown rice");
    expect(out).not.toContain("Brown won");
  });

  it("finds other people after honorifics, role labels and in author lists", () => {
    expect(matches("Advised by Prof. Elena Vasquez")).toContain("Elena Vasquez");
    expect(matches("Supervisor: Ana Ruiz")).toContain("Ana Ruiz");
    expect(matches("under the supervision of Lena Park Kim")).toContain("Lena Park Kim");
    expect(matches("E. Vasquez, A. Mehta, and K. Osei. Poster, 2026.")).toEqual(["E. Vasquez", "A. Mehta", "K. Osei"]);
    expect(kinds("B.S. Computer Science")).toEqual([]);
  });

  it("leaves typed placeholders alone", () => {
    expect(detectPii("[email] [phone] [link] [address] [id] [name] [removed]", { names: ["Name Person"] })).toEqual([]);
  });
});

describe("redactPii", () => {
  it("replaces right to left with typed placeholders and lists what it took", () => {
    const r = redactPii("Jane Doe | jane@example.com | (555) 010-0100 | github.com/janedoe", { names: ["Jane Doe"] });
    expect(r.text).toBe("[name] | [email] | [phone] | [link]");
    expect(r.removed.map((x) => x.kind)).toEqual(["name", "email", "phone", "link"]);
    expect(r.removed.every((x) => x.reason.length > 0)).toBe(true);
  });

  it("handles empty and non-string input", () => {
    expect(detectPii("")).toEqual([]);
    expect(detectPii(undefined as unknown as string)).toEqual([]);
  });
});
