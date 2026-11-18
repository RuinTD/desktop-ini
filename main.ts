import assert from "node:assert";
import * as INI from "@std/ini";
import chardet from "chardet";
import $ from "dax";
import iconv from "iconv-lite";
import type { Buffer } from "node:buffer";
import * as z from "zod";

type PathLike = Parameters<typeof $.path>[0];

const String = z.coerce.string();

const IniValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const IniSection = z.record(z.string(), IniValue);
const Ini = z.record(z.string(), IniValue.or(IniSection));
type Ini = z.infer<typeof Ini>;

const Bit = z.union([z.literal(0), z.literal(1)]);
const BitBool = z.codec(Bit, z.boolean(), {
  decode: (bit) => !!bit,
  encode: (bool) => (bool ? 1 : 0),
});

const FolderType = z.enum([
  "Documents",
  "MyDocuments",
  "Pictures",
  "MyPictures",
  "PhotoAlbum",
  "Music",
  "MyMusic",
  "MusicArtist",
  "MusicAlbum",
  "Videos",
  "MyVideos",
  "VideoAlbum",
  "UseLegacyHTT",
  "CommonDocuments",
  "Generic",
]);
type FolderType = z.infer<typeof FolderType>;

const DefaultDropEffect = z.enum({
  Copy: 1,
  Move: 2,
  CreateShortcut: 4,
});
type DefaultDropEffect = z.infer<typeof DefaultDropEffect>;

function escapePath(path: string) {
  return path.includes(",") ? `"${path}"` : path;
}

function createResourceCodec<
  TIsName extends boolean = false,
  TFileOptional extends boolean = false,
>(options: { isName?: TIsName; fileOptional?: TFileOptional } = {}) {
  const { isName = false as TIsName, fileOptional = false as TFileOptional } =
    options;

  type OutSchema = TFileOptional extends true
    ? z.ZodOptional<z.ZodString>
    : z.ZodString;
  const OutFile = (
    fileOptional ? z.string().optional() : z.string()
  ) as OutSchema;

  return z.union([
    z.codec(
      z.string(),
      z.object({
        file: OutFile,
        index: z.number().optional(),
      }),
      {
        decode(input) {
          if (isName) {
            assert(input.startsWith("@"), `Invalid resource format: ${input}`);
            input = input.slice(1);
          }

          const match = input.match(/^"?(.*?)"?,\s*(-?\d+)$/);
          assert(match, `Invalid format: ${input}`);

          const [, file, index] = match as [string, string, string];
          if (!fileOptional) assert(file, `Invalid file: ${file}`);
          return {
            file: file || undefined,
            index: parseInt(index, 10),
          };
        },
        encode(value: { file?: string; index?: number }) {
          const prefix = isName ? "@" : "";
          const path = escapePath(value.file || "");
          return `${prefix}${path},${value.index || 0}`;
        },
      },
    ),
    (isName ? z.string() : z.never()) as TIsName extends true
      ? z.z.ZodString
      : z.ZodNever,
  ]);
}

export const IconResource = createResourceCodec();
export const LocalizedResourceName = createResourceCodec({ isName: true });
export const LocalizedFileName = createResourceCodec({
  isName: true,
  fileOptional: true,
});

const ShellClassInfo = z
  .looseObject({
    ConfirmFileOp: BitBool.optional(),
    IconFile: String.optional(),
    IconIndex: z.number().optional(),
    IconResource: IconResource.optional(),
    InfoTip: String.optional(),
    LocalizedResourceName: LocalizedResourceName.optional(),
    FolderType: FolderType.optional(),
    DefaultDropEffect: DefaultDropEffect.optional(),
  })
  .catchall(IniValue);

const LocalizedFileNames = z.record(z.string(), LocalizedFileName);

const DesktopIni = z
  .looseObject({
    ".ShellClassInfo": ShellClassInfo.optional(),
    LocalizedFileNames: LocalizedFileNames.optional(),
  })
  .catchall(IniValue.or(IniSection));
export type DesktopIni = z.infer<typeof DesktopIni>;

export async function readIni(
  file: PathLike,
  defaultEncoding: string = "utf8",
): Promise<Record<string, unknown>> {
  file = $.path(file);
  const bytes = await file.readBytes();
  const encoding = chardet.detect(bytes);
  const decoded = iconv.decode(bytes, encoding || defaultEncoding);
  return INI.parse(decoded);
}

export async function readDesktopIni(path: PathLike): Promise<DesktopIni> {
  path = $.path(path);
  try {
    if (path.basename().toLowerCase() != "desktop.ini")
      path = path.join("desktop.ini");
    return DesktopIni.parse(await readIni(path, "win1252"));
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code == "ENOENT")
      return {};
    throw e;
  }
}

export function encodeIni(
  ini: Ini,
  encoding: string = "utf8",
  addBOM: boolean = false,
): Buffer {
  return iconv.encode(INI.stringify(ini), encoding, { addBOM });
}

export async function writeIni(
  file: PathLike,
  ini: Ini,
  encoding: string = "utf8",
  addBOM: boolean = false,
) {
  file = $.path(file);
  const data = encodeIni(ini, encoding, addBOM);
  await file.write(data);
}

export async function writeDesktopIni(path: PathLike, ini: DesktopIni) {
  path = $.path(path);
  if (path.basename().toLowerCase() != "desktop.ini")
    path = path.join("desktop.ini");
  const parent = path.dirname();

  await path.ensureRemove();
  await writeIni(path, DesktopIni.encode(ini));
  await $`attrib +S +H ${path}`.quiet();
  await $`attrib +R ${parent}`.quiet();
}
