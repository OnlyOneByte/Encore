"""B-7-C2: the storage-class key helpers. These MUST agree byte-for-byte with the core's
paths.ts, because the TV resolves /media/<ref> -- a mismatch 404s on a file that exists.
"""
from src import processor


def test_derived_keys_live_under_the_derived_class():
    assert processor.instrumental_path("/m", "id1") == "/m/derived/stems/id1-instrumental.wav"
    assert processor.vocals_path("/m", "id1") == "/m/derived/stems/id1-vocals.wav"
    assert processor.pitch_track_path("/m", "id1") == "/m/derived/pitch/id1-pitch.json"


def test_raw_audio_is_its_own_unrecoverable_class():
    # NOT under stems/_work -- that scratch path is what silently accumulated 432MB on the live box
    # while being the only asset that cannot be regenerated.
    assert processor.source_audio_path("/m", "id1") == "/m/audio/id1.wav"
    assert processor.source_audio_path("/m", "id1", "m4a") == "/m/audio/id1.m4a"
    assert processor.source_audio_path("/m", "id1", ".opus") == "/m/audio/id1.opus"
