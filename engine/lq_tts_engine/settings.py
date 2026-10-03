from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Format = Literal["mp3", "wav", "srt", "vtt"]


class JobSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")

    speed: float = Field(0.9, ge=0.7, le=1.3)
    pause_sentence_s: float = Field(0.45, ge=0, le=3)
    pause_paragraph_s: float = Field(0.80, ge=0, le=3)
    loudness_lufs: float = Field(-14.0, ge=-24, le=-9)
    formats: list[Format] = Field(default_factory=lambda: ["mp3", "wav", "srt", "vtt"])

    @field_validator("formats")
    @classmethod
    def _non_empty_unique(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("formats must not be empty")
        return list(dict.fromkeys(value))
