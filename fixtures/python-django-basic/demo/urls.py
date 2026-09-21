from django.http import JsonResponse
from django.urls import path


def index(request):
    return JsonResponse({"fixture": "python-django-basic", "serving": True})


urlpatterns = [path("", index)]
