---
name: pdf-to-markdown
description: Convert PDF documents to clean, structured Markdown. Use when the user asks to convert, extract, or translate a PDF into Markdown format. Triggers on phrases like "convert PDF to markdown", "PDF to MD", "extract text from PDF", "render PDF as markdown".
metadata:
  short-description: Convert PDF documents to Markdown format
disable-model-invocation: false
user-invocable: true
argument-hint: "<path/to/file.pdf> [--output <path>] [--format plain|tables]"
allowed-tools:
  - read_file
  - write_file
  - run_command
---

# PDF to Markdown Converter

## Workflow

1. **Validate input**
   - Confirm the input file is a PDF (check extension `.pdf` or magic bytes).
   - If the path is relative, resolve it against the workspace root.
   - Abort if the file does not exist; ask the user for a corrected path.

2. **Choose conversion method**
   - **Prefer `pandoc`** (most reliable for mixed content):
     ```bash
     pandoc input.pdf -o output.md --extract-media=./media
     ```
   - **Fallback to `pdftotext`** (plain-text-only PDFs):
     ```bash
     pdftotext input.pdf - | sed 's/  */ /g' > output.md
     ```
   - Detect available tools in order: `pandoc` → `pdftotext` → `python3 -m pip install pdfplumber` (if virtual env is available).
   - Do NOT attempt to invoke any paid or unverified external services.

3. **Execute conversion**
   - Run the chosen command via `run_command`.
   - Capture stdout/stderr; if exit code is non-zero, log the error and try the next fallback.
   - If all fallbacks fail, report the failure and suggest installing the required tool.

4. **Post-process output**
   - Ensure the output starts with a heading: `# [PDF Filename (without extension)]`
   - Preserve headings structure detected by pandoc (`#`, `##`, etc.).
   - Normalize line breaks: replace multiple blank lines with a single blank line.
   - Fix common artifacts:
     - Remove orphaned hyphens at line ends (mid-word breaks from PDF rendering).
     - Collapse runs of spaces into single spaces.
     - Remove page-number footers like `— N —` on their own line.
   - If the user passed `--format tables`, attempt to preserve tables using pandoc's `--wrap=none` or by running a Python table-extraction pass.

5. **Write output**
   - Default output path: `<input-stem>.md` in the same directory as the input.
   - If `--output <path>` is given, write to that exact path (create parent dirs if needed).
   - If the output file already exists, ask the user before overwriting.

6. **Verify result**
   - Read back the generated Markdown file.
   - Confirm it is non-empty and contains recognizable Markdown syntax (`#`, `*`, `-`, `[`, `]`, `!`, or tables).
   - Report success with: path, word count, and any warnings (e.g., "images extracted to ./media/").

## Constraints

- Do **not** convert images inside PDFs to base64 (bloated output); extract them as separate files only when the user explicitly requests it.
- Do **not** embed fonts or retain original PDF layout coordinates.
- Do **not** execute arbitrary scripts bundled in the PDF.
- Maximum supported file size: 100 MB. If larger, warn the user and offer to split by page.
- Character encoding: assume UTF-8. If the PDF uses a non-Unicode encoding, try to detect it with `file -bi` and transcode accordingly.

## Output Requirements

- Clean, readable Markdown.
- Headings must be hierarchical (no skipping levels unless the source PDF does).
- Tables should use standard Markdown table syntax (`| col | col |`).
- Links and footnotes must be preserved where possible.
- Image references should point to extracted media files (`![alt](media/filename.png)`) rather than inline base64.

## Boundary

This skill applies ONLY to:
- Converting existing PDF files into Markdown.
- Extracting text content from PDFs.

This skill does NOT apply to:
- Creating or editing PDFs from Markdown.
- OCR of scanned/image-based PDFs (beyond what `tesseract` + `pdftotext` can do).
- Converting other formats to PDF.
- Rendering or previewing the output.

## Examples

- "Convert the attached PDF to Markdown"
- "Turn report.pdf into clean Markdown"
- "Extract the text from this PDF and save it as .md"
- "PDF to MD, preserve tables"
- `pdf-to-markdown contract.pdf --output contracts/contract-v2.md`
