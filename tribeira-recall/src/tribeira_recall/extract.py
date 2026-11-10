from __future__ import annotations

import hashlib
import re
from pathlib import Path

import tree_sitter_python
import tree_sitter_rust
import tree_sitter_typescript
from tree_sitter import Language, Node, Parser

from .db import Document

CODE_SUFFIXES = {".py", ".ts", ".tsx", ".rs"}
DECLARATIONS = {
    "function_definition",
    "class_definition",
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "abstract_class_declaration",
    "function_item",
    "struct_item",
    "enum_item",
    "trait_item",
    "type_alias_declaration",
    "interface_declaration",
}


def file_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def extract_code(path: Path, repo_path: Path, data: bytes) -> list[Document]:
    suffix = path.suffix
    if suffix == ".py":
        language = Language(tree_sitter_python.language())
    elif suffix == ".rs":
        language = Language(tree_sitter_rust.language())
    elif suffix in {".ts", ".tsx"}:
        grammar = tree_sitter_typescript.language_tsx if suffix == ".tsx" else tree_sitter_typescript.language_typescript
        language = Language(grammar())
    else:
        return []
    parser = Parser(language)
    tree = parser.parse(data)
    relative = str(path.relative_to(repo_path))
    repo = repo_path.name
    repo_id = hashlib.sha256(str(repo_path.resolve()).encode()).hexdigest()[:16]
    digest = file_hash(data)
    documents: list[Document] = []

    def visit(node: Node) -> None:
        target = node
        exported = node.type in {"export_statement", "decorated_definition"}
        if exported and node.named_child_count == 1:
            target = node.named_children[0]
        if target.type == "lexical_declaration" and exported:
            for declarator in (child for child in target.named_children if child.type == "variable_declarator"):
                name_node = declarator.child_by_field_name("name")
                if name_node:
                    add_symbol(node, declarator, name_node, "export")
        if target.type in DECLARATIONS:
            name_node = target.child_by_field_name("name")
            if name_node:
                add_symbol(node, target, name_node, "symbol")
        for child in node.named_children:
            visit(child)

    def add_symbol(container: Node, declaration: Node, name_node: Node, kind: str) -> None:
        name = text(data, name_node).strip()
        line = container.start_point[0] + 1
        body = declaration.child_by_field_name("body")
        signature_end = body.start_byte if body else min(declaration.end_byte, declaration.start_byte + 500)
        signature = clean_space(data[declaration.start_byte:signature_end].decode("utf-8", "replace"))[:500]
        doc = documentation(container, declaration, data)
        source_text = text(data, container)
        content = "\n".join(part for part in (signature, doc, source_text[:1200]) if part)
        documents.append(
            Document(
                doc_key=f"symbol:{repo_id}:{relative}:{line}:{name}",
                kind=kind,
                repo=repo,
                source=f"{relative}:{line}",
                title=name,
                content=content,
                signature=signature,
                line=line,
                content_hash=digest,
                origin=str(path),
            )
        )

    visit(tree.root_node)
    return documents


def extract_document(path: Path, base: Path, repo: str | None, data: bytes) -> list[Document]:
    text_data = data.decode("utf-8", "replace")
    relative = str(path.relative_to(base))
    repo_id = hashlib.sha256(str(base.resolve()).encode()).hexdigest()[:16] if repo else "global"
    digest = file_hash(data)
    chunks = markdown_chunks(text_data)
    documents = []
    for number, chunk in enumerate(chunks, 1):
        heading = next((line.lstrip("#").strip() for line in chunk.splitlines() if line.startswith("#")), "")
        title = heading or f"{path.name} chunk {number}"
        documents.append(
            Document(
                doc_key=f"doc:{repo_id}:{relative}:{number}",
                kind="doc",
                repo=repo,
                source=f"{relative}#chunk-{number}",
                title=title[:200],
                content=chunk,
                content_hash=digest,
                origin=str(path),
            )
        )
    return documents


def markdown_chunks(text_data: str, limit: int = 1400) -> list[str]:
    sections = re.split(r"(?m)(?=^#{1,3} )", text_data)
    chunks: list[str] = []
    current = ""
    for section in sections:
        paragraphs = re.split(r"\n\s*\n", section)
        for paragraph in paragraphs:
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            while len(paragraph) > limit:
                cut = paragraph.rfind("\n", 0, limit)
                if cut < limit // 2:
                    cut = limit
                part, paragraph = paragraph[:cut], paragraph[cut:].lstrip()
                if current:
                    chunks.append(current)
                    current = ""
                chunks.append(part)
            candidate = f"{current}\n\n{paragraph}" if current else paragraph
            if len(candidate) > limit and current:
                chunks.append(current)
                current = paragraph
            else:
                current = candidate
    if current:
        chunks.append(current)
    return chunks


def documentation(container: Node, declaration: Node, data: bytes) -> str:
    if declaration.type == "function_definition":
        body = declaration.child_by_field_name("body")
        if body and body.named_children:
            first = body.named_children[0]
            if first.type == "expression_statement" and first.named_children and first.named_children[0].type == "string":
                return clean_doc(text(data, first.named_children[0]))
    sibling = container.prev_named_sibling
    comments: list[str] = []
    while sibling and sibling.type in {"comment", "line_comment", "block_comment"}:
        comments.insert(0, text(data, sibling))
        if sibling.end_point[0] + 1 < container.start_point[0] and comments:
            break
        sibling = sibling.prev_named_sibling
    return clean_doc("\n".join(comments))


def clean_doc(value: str) -> str:
    value = value.strip().strip("\"'").strip("/").strip()
    value = re.sub(r"(?m)^\s*(?://+|#+|\*+|/+[!*]?)\s?", "", value)
    return clean_space(value)[:300]


def clean_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def text(data: bytes, node: Node) -> str:
    return data[node.start_byte : node.end_byte].decode("utf-8", "replace")
