"""The model gate serves interactive callers (chat) before background job workers."""
import threading
import time

from studyapp import llm


def test_chat_goes_before_a_job_that_calls_again():
    gate = llm._Gate(1)
    order = []
    job_holding = threading.Event()

    def job():
        llm.set_wait_hook(lambda kind: None)  # marks this thread as a job worker
        for i in range(5):  # a job making calls back to back, like a generation's sections
            with gate:
                order.append(f"job{i}")
                job_holding.set()
                time.sleep(0.05)

    def chat():
        job_holding.wait()
        with gate:
            order.append("chat")

    threads = [threading.Thread(target=job), threading.Thread(target=chat)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert order.index("chat") <= 2, order  # after the call in progress, not after the whole job


def test_gate_busy_and_slots():
    gate = llm._Gate(2)
    with gate:
        assert not gate.busy()
        with gate:
            assert gate.busy()
    assert not gate.busy()
