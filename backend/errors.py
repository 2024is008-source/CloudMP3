from __future__ import annotations


class ServiceError(Exception):
    """Error that maps to a JSON error response for the Worker."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
