class SpeechError(Exception):
    """Safe, provider-independent error. Never include native exceptions/model paths."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
