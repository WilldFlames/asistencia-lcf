from pathlib import Path
from docx import Document
from docx.document import Document as DocumentType
from docx.table import Table
from docx.text.paragraph import Paragraph


def blocks(parent):
    root = parent.element.body if isinstance(parent, DocumentType) else parent._tc
    for child in root.iterchildren():
        if child.tag.endswith("}p"):
            yield Paragraph(child, parent)
        elif child.tag.endswith("}tbl"):
            yield Table(child, parent)


base = Path(r"C:\Users\Steven\Downloads")
names = [
    "05_Constancia_acciones_correctivas_cumplidas.docx",
    "06_Constancia_sin_acciones_correctivas.docx",
    "01_Reparacion_comunitaria.docx",
    "02_Aseo_comunitario.docx",
    "03_Aprendizaje_servicio.docx",
    "07_Carta_accion_correctiva_pendiente.docx",
    "09_Informe_docente_guia_inasistencia_TES.docx",
    "08_Carta_condicion_academica_y_ampliacion.docx",
]

for name in names:
    doc = Document(base / name)
    print("\n" + "=" * 100)
    print(name)
    print("=" * 100)
    for section_no, section in enumerate(doc.sections, 1):
        header = " | ".join(p.text.strip() for p in section.header.paragraphs if p.text.strip())
        footer = " | ".join(p.text.strip() for p in section.footer.paragraphs if p.text.strip())
        if header:
            print(f"[HEADER {section_no}] {header}")
        if footer:
            print(f"[FOOTER {section_no}] {footer}")
    for item in blocks(doc):
        if isinstance(item, Paragraph):
            text = item.text.replace("\t", " <TAB> ").strip()
            if text:
                print(f"[P:{item.style.name}] {text}")
        else:
            print(f"[TABLE {len(item.rows)}x{len(item.columns)}]")
            for ri, row in enumerate(item.rows, 1):
                cells = []
                for cell in row.cells:
                    value = " / ".join(p.text.strip() for p in cell.paragraphs if p.text.strip())
                    cells.append(value)
                print(f"  R{ri}: " + " || ".join(cells))
