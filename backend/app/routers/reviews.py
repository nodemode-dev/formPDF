import asyncio

from fastapi import APIRouter

from app.services import reviews

router = APIRouter()


@router.get("/reviews")
async def get_reviews() -> dict:
    return {"reviews": await asyncio.to_thread(reviews.all_reviews)}
