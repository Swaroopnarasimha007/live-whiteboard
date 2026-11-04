from app.speech.models import model_valid


def test_whisper_layout_requires_all_runtime_files(tmp_path):
    assert not model_valid(tmp_path)
    for name in ("model.bin", "config.json"):
        (tmp_path / name).touch()
    assert not model_valid(tmp_path)
    (tmp_path / "tokenizer.json").touch()
    assert model_valid(tmp_path)
