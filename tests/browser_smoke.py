#!/usr/bin/env python3
"""Exercise the served trainer in Chromium. Requires Python Playwright.

Run `npm start` first, then:
  python3 tests/browser_smoke.py --base-url http://127.0.0.1:3000
The default Chromium path is /usr/bin/chromium; override with --chromium.
Screenshots are written outside the checkout, under /tmp.
"""

import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


STORAGE_KEY = "boo-trainer:v1"
DATA = json.loads((Path(__file__).resolve().parents[1] / "public/questions.json").read_text())
FIRST_TICKET = DATA["tickets"][0]
FIRST = FIRST_TICKET["questions"][0]
SECOND = FIRST_TICKET["questions"][1]
FIRST_TICKET_ID = str(FIRST_TICKET["id"])
FIRST_TICKET_SIZE = len(FIRST_TICKET["questions"])
ALL_QUESTIONS = [question for ticket in DATA["tickets"] for question in ticket["questions"]]
LAST_TICKET = DATA["tickets"][-1]


def action(page, name, extra=""):
    return page.locator(f'[data-action="{name}"]{extra}')


def navigate(page, destination):
    action(page, "navigate", f'[data-page="{destination}"]').first.click()


def stored(page):
    return page.evaluate("key => JSON.parse(localStorage.getItem(key))", STORAGE_KEY)


def choose_answer(page, question, correct=True):
    option = question["correctOptionId"]
    if not correct:
        option = next(item["id"] for item in question["options"] if item["id"] != option)
    action(page, "answer", f'[data-option="{option}"]').click()
    return option


def no_overflow(page, label):
    size = page.evaluate("({viewport: innerWidth, content: document.documentElement.scrollWidth})")
    assert size["content"] <= size["viewport"] + 1, f"Horizontal overflow on {label}: {size}"


def wait_home(page):
    expect(page.locator(".page-heading h1")).to_have_text("Подготовьтесь спокойно.")


def monitor(page, errors):
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("console", lambda message: errors.append(message.text) if message.type == "error" else None)


def question_signature(question):
    def normalized(value):
        return re.sub(r"\s+", " ", value.lower().replace("ё", "е")).strip()
    return normalized(question["text"]), tuple(normalized(option["text"]) for option in question["options"])


def deduplicated_learning_flow(browser, base_url, errors):
    context = browser.new_context()
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    page.locator('[data-setting="ticketId"]').select_option("0")
    action(page, "start").click()
    session = stored(page)["session"]
    assert len(session["questionIds"]) == len(ALL_QUESTIONS)
    assert len(set(session["questionIds"])) == len(ALL_QUESTIONS)
    seen = set()
    for index, question in enumerate(ALL_QUESTIONS):
        expect(page.locator(".question-text")).to_have_text(question["text"])
        signature = question_signature(question)
        assert signature not in seen, f"Repeated question in all-bank learning: {question['id']}"
        seen.add(signature)
        choose_answer(page, question)
        action(page, "check").click()
        expect(page.locator(".feedback.positive")).to_be_visible()
        action(page, "next").click()
        if (index + 1) % 25 == 0:
            print(f"  all-bank learning: {index + 1}/{len(ALL_QUESTIONS)} unique questions")
    expect(page.locator(".results h1")).to_have_text("Вы стали на шаг увереннее.")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text(f"{len(ALL_QUESTIONS)} / {len(ALL_QUESTIONS)}")
    assert len(stored(page)["answers"]) == len(ALL_QUESTIONS)
    assert stored(page)["mistakes"] == []
    print(f"PASS all-bank learning completes {len(ALL_QUESTIONS)} questions without repeats")
    context.close()


def incomplete_ticket_flow(browser, base_url, errors):
    context = browser.new_context()
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    size = len(LAST_TICKET["questions"])
    assert size < FIRST_TICKET_SIZE, "Regression fixture requires a final incomplete ticket"
    for mode in ("learn", "exam"):
        if mode == "exam":
            navigate(page, "home")
            action(page, "mode", '[data-mode="exam"]').click()
            page.locator('[data-setting="allowedErrors"]').select_option("0")
        page.locator('[data-setting="ticketId"]').select_option(str(LAST_TICKET["id"]))
        action(page, "start").click()
        assert len(stored(page)["session"]["questionIds"]) == size
        for index, question in enumerate(LAST_TICKET["questions"]):
            expect(page.locator(".question-text")).to_have_text(question["text"])
            expect(page.locator(".exercise-top")).to_contain_text(f"Вопрос {index + 1} из {size}")
            choose_answer(page, question)
            if mode == "learn":
                action(page, "check").click()
                action(page, "next").click()
            elif index + 1 < size:
                action(page, "next").click()
            else:
                action(page, "finish").first.click()
                action(page, "confirm-finish").click()
        expect(page.locator(".results h1")).to_be_visible()
        expect(page.locator(".result-stats > div").nth(0)).to_contain_text(f"{size} / {size}")
        expect(page.locator(".result-stats > div").nth(1).locator("strong")).to_have_text("0")
        assert stored(page)["session"]["status"] == "finished"
    record = stored(page)["exams"][-1]
    assert record["correct"] == record["total"] == size
    assert record["bankVersion"] == 2
    navigate(page, "history")
    expect(page.locator(".history-score")).to_contain_text(f"{size} / {size}")
    print(f"PASS final {size}-question ticket completes in learning and exam with correct score")
    context.close()


def migration_fixture(page, duplicate, distinct, mode, index):
    aliases = duplicate["aliases"][:2]
    distinct_alias = distinct["aliases"][0]
    wrong = next(option["id"] for option in duplicate["options"] if option["id"] != duplicate["correctOptionId"])
    now = page.evaluate("Date.now()")
    old_record = {"ticketId": 1, "total": 10, "correct": 9, "answered": 10, "errors": 1,
                  "passed": True, "allowedErrors": 1, "finishedAt": now - 100000, "duration": 300000}
    value = {
        "version": 1,
        "answers": {aliases[0]: {"attempts": 2, "correct": 1}, aliases[1]: {"attempts": 3, "correct": 2}},
        "mistakes": aliases + [aliases[0]],
        "exams": [old_record],
        "session": {
            "mode": mode, "ticketId": None if mode == "learn" else 1,
            "questionIds": aliases + [distinct_alias], "index": index,
            "responses": {aliases[0]: wrong, aliases[1]: wrong},
            "checked": (aliases if index == 2 else aliases[:1]) if mode == "learn" else [],
            "startedAt": now - 30000, "deadline": now + 270000 if mode == "exam" else None,
            "allowedErrors": 1, "status": "active",
        },
    }
    page.evaluate("({key, value}) => localStorage.setItem(key, JSON.stringify(value))", {"key": STORAGE_KEY, "value": value})
    return value


def migration_flow(browser, base_url, errors):
    duplicate = next(question for question in ALL_QUESTIONS if len(question.get("aliases", [])) >= 2)
    distinct = next(question for question in ALL_QUESTIONS if question["id"] != duplicate["id"])
    for old_index in (2, 1):
        context = browser.new_context()
        page = context.new_page()
        monitor(page, errors)
        page.goto(base_url)
        wait_home(page)
        migration_fixture(page, duplicate, distinct, "learn", old_index)
        page.reload()
        wait_home(page)
        migrated = stored(page)
        assert migrated["version"] == 2
        assert migrated["answers"] == {duplicate["id"]: {"attempts": 5, "correct": 3}}
        assert migrated["mistakes"] == [duplicate["id"]]
        assert migrated["session"]["questionIds"] == [duplicate["id"], distinct["id"]]
        assert migrated["session"]["checked"] == [duplicate["id"]]
        assert migrated["session"]["index"] == 1, f"Migrated current question from source index {old_index} must advance to the distinct question"
        assert migrated["exams"][0]["bankVersion"] == 1
        expect(page.locator(".stat-card").nth(0)).to_contain_text(f"1 / {len(ALL_QUESTIONS)}")
        expect(page.locator(".stat-card").nth(1)).to_contain_text("60%")
        navigate(page, "mistakes")
        expect(page.locator(".list-question")).to_have_count(1)
        navigate(page, "history")
        expect(page.locator(".history-item")).to_have_count(1)
        expect(page.locator(".history-score")).to_contain_text("9 / 10")
        navigate(page, "home")
        action(page, "resume").click()
        expect(page.locator(".question-text")).to_have_text(distinct["text"])
        expect(page.locator(".exercise-top")).to_contain_text("Вопрос 2 из 2")
        expect(page.locator(".feedback")).to_have_count(0)
        page.reload()
        wait_home(page)
        assert stored(page) == migrated, "Repeated load must not merge migrated attempts again"
        action(page, "resume").click()
        choose_answer(page, distinct)
        action(page, "check").click()
        action(page, "next").click()
        expect(page.locator(".result-stats > div").nth(0)).to_contain_text("1 / 2")
        assert stored(page)["answers"][duplicate["id"]] == {"attempts": 5, "correct": 3}
        assert stored(page)["answers"][distinct["id"]] == {"attempts": 1, "correct": 1}
        context.close()
    print("PASS version1 learning migration merges aliases and preserves/skips current question without regrading")

    context = browser.new_context()
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    raw = migration_fixture(page, duplicate, distinct, "exam", 2)
    page.reload()
    wait_home(page)
    action(page, "resume").click()
    expect(page.locator("#timer")).to_be_visible()
    migrated = stored(page)
    assert migrated["version"] == 2
    assert migrated["session"]["deadline"] == raw["session"]["deadline"]
    assert migrated["session"]["startedAt"] == raw["session"]["startedAt"]
    assert len(migrated["session"]["questionIds"]) == len(set(migrated["session"]["questionIds"]))
    page.reload()
    wait_home(page)
    assert stored(page) == migrated
    action(page, "resume").click()
    expect(page.locator(".question-text")).to_have_text(distinct["text"])
    choose_answer(page, distinct)
    action(page, "finish").first.click()
    action(page, "confirm-finish").click()
    expect(page.locator(".results h1")).to_be_visible()
    assert stored(page)["exams"][0]["bankVersion"] == 1
    assert len(stored(page)["exams"]) == 2
    print("PASS migrated exam preserves its original deadline and keeps old exam history")
    context.close()


def desktop_flow(browser, base_url, errors):
    context = browser.new_context(viewport={"width": 1440, "height": 1080})
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    expect(page.locator(".stat-card")).to_have_count(3)
    assert page.locator('[data-setting="ticketId"] option').count() == len(DATA["tickets"]) + 1
    no_overflow(page, "desktop home")

    page.locator('[data-setting="ticketId"]').select_option(FIRST_TICKET_ID)
    action(page, "start").click()
    expect(page.locator(".question-text")).to_have_text(FIRST["text"])
    expect(action(page, "check")).to_be_disabled()
    wrong = choose_answer(page, FIRST, correct=False)
    expect(page.locator(".feedback")).to_have_count(0)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_contain_text(f'вариант {FIRST["correctOptionId"]}')
    expect(page.locator(f'.answer.correct[data-option="{FIRST["correctOptionId"]}"]')).to_be_disabled()
    expect(page.locator(f'.answer.incorrect[data-option="{wrong}"]')).to_be_visible()
    progress = stored(page)
    assert progress["mistakes"] == [FIRST["id"]]
    assert progress["answers"][FIRST["id"]] == {"attempts": 1, "correct": 0}

    page.reload()
    wait_home(page)
    action(page, "resume").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    assert stored(page) == progress, "Reload must not repeat grading"
    action(page, "next").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    choose_answer(page, SECOND)
    action(page, "check").click()
    expect(page.locator(".feedback.positive")).to_be_visible()
    assert stored(page)["answers"][SECOND["id"]] == {"attempts": 1, "correct": 1}

    navigate(page, "mistakes")
    expect(page.locator(".list-question")).to_have_count(1)
    expect(page.locator(".list-question h2")).to_have_text(FIRST["text"])
    before_cancel = stored(page)
    action(page, "review").click()
    expect(page.locator("dialog[open]")).to_contain_text("Начать новую")
    action(page, "cancel-finish").click()
    expect(page.locator("dialog[open]")).to_have_count(0)
    assert stored(page) == before_cancel, "Cancel replacement must preserve the current training"
    action(page, "review").click()
    action(page, "confirm-finish").click()
    expect(page.locator(".question-text")).to_have_text(FIRST["text"])
    assert stored(page)["session"]["questionIds"] == [FIRST["id"]]
    choose_answer(page, FIRST)
    action(page, "check").click()
    expect(page.locator(".feedback.positive")).to_be_visible()
    assert stored(page)["mistakes"] == []
    assert stored(page)["answers"][FIRST["id"]] == {"attempts": 2, "correct": 1}
    action(page, "next").click()
    expect(page.locator(".results h1")).to_have_text("Вы стали на шаг увереннее.")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text("1 / 1")
    print("PASS learning, feedback, persistence, cancellation, and mistake correction")

    navigate(page, "home")
    action(page, "mode", '[data-mode="exam"]').click()
    page.locator('[data-setting="ticketId"]').select_option(FIRST_TICKET_ID)
    page.locator('[data-setting="minutes"]').select_option("5")
    page.locator('[data-setting="allowedErrors"]').select_option("0")
    action(page, "start").click()
    expect(page.locator("#timer")).to_be_visible()
    original_deadline = stored(page)["session"]["deadline"]
    choose_answer(page, FIRST, correct=False)
    action(page, "next").click()
    action(page, "previous").click()
    expect(page.locator(".answer.chosen")).to_have_count(1)
    choose_answer(page, FIRST)
    action(page, "jump", '[data-index="1"]').click()
    page.reload()
    wait_home(page)
    action(page, "resume").click()
    expect(page.locator(".question-text")).to_have_text(SECOND["text"])
    assert stored(page)["session"]["deadline"] == original_deadline, "Exam reload must preserve deadline"
    for index, question in enumerate(FIRST_TICKET["questions"][1:], start=1):
        expect(page.locator(".question-text")).to_have_text(question["text"])
        choose_answer(page, question)
        expect(page.locator(".feedback, .answer.correct, .answer.incorrect")).to_have_count(0)
        if index < FIRST_TICKET_SIZE - 1:
            action(page, "next").click()
    action(page, "finish").first.click()
    expect(page.locator("dialog[open]")).to_contain_text("Все ответы выбраны")
    action(page, "cancel-finish").click()
    assert stored(page)["session"]["status"] == "active"
    action(page, "finish").first.click()
    action(page, "confirm-finish").click()
    expect(page.locator(".results h1")).to_have_text("Отлично, экзамен сдан!")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text(f"{FIRST_TICKET_SIZE} / {FIRST_TICKET_SIZE}")
    assert stored(page)["exams"][-1]["correct"] == FIRST_TICKET_SIZE
    assert stored(page)["exams"][-1]["allowedErrors"] == 0
    navigate(page, "history")
    expect(page.locator(".history-item")).to_have_count(1)
    expect(page.locator(".history-score")).to_contain_text(f"{FIRST_TICKET_SIZE} / {FIRST_TICKET_SIZE}")
    expect(page.locator(".history-score")).to_contain_text("Экзамен сдан")
    print("PASS exam navigation, hidden feedback, deadline persistence, grading, and history")

    navigate(page, "home")
    action(page, "mode", '[data-mode="exam"]').click()
    page.locator('[data-setting="ticketId"]').select_option(FIRST_TICKET_ID)
    page.locator('[data-setting="minutes"]').select_option("5")
    page.locator('[data-setting="allowedErrors"]').select_option("0")
    action(page, "start").click()
    choose_answer(page, FIRST)
    page.evaluate("""key => {
        const value = JSON.parse(localStorage.getItem(key));
        value.session.deadline = Date.now() - 1000;
        value.session.startedAt = value.session.deadline - 300000;
        localStorage.setItem(key, JSON.stringify(value));
    }""", STORAGE_KEY)
    page.reload()
    expect(page.locator(".results h1")).to_have_text("Ещё немного практики.")
    expect(page.locator(".result-stats > div").nth(0)).to_contain_text(f"1 / {FIRST_TICKET_SIZE}")
    expect(page.locator(".result-stats > div").nth(1)).to_contain_text(f"пропущено: {FIRST_TICKET_SIZE - 1}")
    expect(page.locator(".review-question")).to_have_count(FIRST_TICKET_SIZE - 1)
    expired = stored(page)
    assert len(expired["exams"]) == 2
    assert expired["exams"][-1]["duration"] == 300000
    assert expired["session"]["status"] == "finished"
    page.reload()
    wait_home(page)
    assert stored(page) == expired, "Expired exam must be graded only once across reloads"
    expect(action(page, "resume")).to_have_count(0)
    print("PASS automatic completion of expired exam, unanswered grading, and idempotent reload")
    page.screenshot(path="/tmp/boo-desktop.png", full_page=True)
    context.close()


def mobile_flow(browser, base_url, errors):
    context = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    page = context.new_page()
    monitor(page, errors)
    page.goto(base_url)
    wait_home(page)
    for width in (320, 390, 768):
        page.set_viewport_size({"width": width, "height": 844})
        no_overflow(page, f"home {width}px")
    page.set_viewport_size({"width": 390, "height": 844})
    page.screenshot(path="/tmp/boo-mobile.png", full_page=True)
    navigate(page, "tickets")
    expect(page.locator(".ticket-card")).to_have_count(len(DATA["tickets"]))
    no_overflow(page, "mobile tickets")
    action(page, "ticket-learn", f'[data-ticket="{FIRST_TICKET_ID}"]').click()
    choose_answer(page, FIRST, correct=False)
    action(page, "check").click()
    expect(page.locator(".feedback.negative")).to_be_visible()
    no_overflow(page, "mobile feedback")
    navigate(page, "mistakes")
    expect(page.locator(".list-question")).to_have_count(1)
    no_overflow(page, "mobile mistakes")
    action(page, "review").click()
    no_overflow(page, "mobile confirmation")
    action(page, "confirm-finish").click()
    choose_answer(page, FIRST)
    action(page, "check").click()
    action(page, "next").click()
    expect(page.locator(".results h1")).to_be_visible()
    no_overflow(page, "mobile results")
    navigate(page, "history")
    expect(page.locator(".empty-state")).to_be_visible()
    no_overflow(page, "mobile history")
    print("PASS mobile navigation, answer flow, confirmation, and layout at 320/390/768px")
    context.close()


def failed_load_flow(browser, base_url):
    context = browser.new_context()
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("**/questions.json*", lambda route: route.fulfill(status=503, body="Temporarily unavailable"))
    page.goto(base_url)
    expect(page.locator(".error-state h1")).to_have_text("Не удалось открыть тренажёр")
    expect(page.locator(".error-state")).to_contain_text("503")
    page.unroute("**/questions.json*")
    page.locator("#retry").click()
    wait_home(page)
    assert not errors, f"Uncaught error during failed-load recovery: {errors}"
    print("PASS failed question download and retry recovery")
    context.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    args = parser.parse_args()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=["--no-sandbox"])
        errors = []
        desktop_flow(browser, args.base_url, errors)
        mobile_flow(browser, args.base_url, errors)
        failed_load_flow(browser, args.base_url)
        deduplicated_learning_flow(browser, args.base_url, errors)
        incomplete_ticket_flow(browser, args.base_url, errors)
        migration_flow(browser, args.base_url, errors)
        browser.close()
        assert not errors, f"Browser errors: {errors}"
    print("Browser smoke passed; screenshots: /tmp/boo-desktop.png, /tmp/boo-mobile.png")


if __name__ == "__main__":
    main()
