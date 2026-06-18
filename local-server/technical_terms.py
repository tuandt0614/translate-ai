from __future__ import annotations

import re
from typing import List, Tuple


TECHNICAL_TERMS = (
  "JavaScript", "TypeScript", "Node.js", "React", "Next.js", "Vue", "Angular",
  "Python", "FastAPI", "PyTorch", "TensorFlow", "Docker", "Kubernetes",
  "GitHub", "GitLab", "Linux", "Windows", "macOS", "Chrome", "YouTube",
  "frontend", "backend", "full-stack", "framework", "runtime", "repository",
  "API", "SDK", "CLI", "HTTP", "HTTPS", "JSON", "XML", "HTML", "CSS",
  "SQL", "NoSQL", "URL", "URI", "GPU", "CPU", "CUDA", "VRAM", "RAM",
  "DevOps", "CI/CD", "REST", "GraphQL", "WebSocket", "OAuth", "JWT",
)

TERM_ALTERNATIVES = "|".join(re.escape(term) for term in sorted(TECHNICAL_TERMS, key=len, reverse=True))
TECHNICAL_PATTERN = re.compile(
  rf"`[^`]+`|https?://\S+|(?:[A-Za-z]:)?[/\\][\w./\\-]+|--?[a-z][\w-]*|"
  rf"\b\w+\.(?:js|ts|jsx|tsx|py|json|html|css|md|yml|yaml|toml|sh)\b|"
  rf"\b(?:[a-z]+[A-Z][A-Za-z0-9]*|[A-Z]{{2,}}[A-Z0-9/-]*)\b|"
  rf"\b(?i:{TERM_ALTERNATIVES})\b",
)


def protect_technical_terms(text: str) -> Tuple[str, List[str]]:
  terms: List[str] = []

  def replace(match: re.Match[str]) -> str:
    terms.append(match.group(0))
    return f"ZXQ{len(terms) - 1}QXZ"

  return TECHNICAL_PATTERN.sub(replace, text), terms


def restore_technical_terms(text: str, terms: List[str]) -> str:
  for index, term in enumerate(terms):
    text = re.sub(
      rf"Z\s*X\s*Q\s*{index}\s*Q\s*X\s*Z",
      lambda _match, value=term: value,
      text,
      flags=re.IGNORECASE,
    )
  return text
