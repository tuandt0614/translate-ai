import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "local-server"))

from technical_terms import protect_technical_terms, restore_technical_terms


source = "React calls the API twice, then the API reads config.json with --verbose."
protected, terms = protect_technical_terms(source)

assert terms == ["React", "API", "API", "config.json", "--verbose"]
assert "React" not in protected
assert restore_technical_terms(protected, terms) == source
assert restore_technical_terms("Z X Q 0 Q X Z", ["Docker"]) == "Docker"

print("technical_terms.test.py passed")
