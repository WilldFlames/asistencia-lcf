from pathlib import Path
from pypdf import PdfReader

base = Path(r"C:\Users\Steven\Downloads")
for name in ("Anexo_3_TES.pdf", "Anexo_4_TES.pdf"):
    reader = PdfReader(base / name)
    print("\n" + "=" * 100)
    print(f"{name} - {len(reader.pages)} pagina(s)")
    print("=" * 100)
    for index, page in enumerate(reader.pages, 1):
        print(f"\n--- PAGINA {index} ---\n")
        print(page.extract_text() or "[SIN TEXTO EXTRAIBLE]")
