#include "decoder.hh"
#include <cstdint>
#include <iostream>
#include <unistd.h>

static DecoderInterface *decoder = nullptr;

void reset_decoder(int sample_rate, int psk) {
    if (decoder) {
        delete decoder;
        decoder = nullptr;
    }
    switch (sample_rate) {
    case 8000:
        switch (psk) {
        case 2:
            decoder = new (std::nothrow) Decoder<8000, 2>;
            break;
        case 4:
            decoder = new (std::nothrow) Decoder<8000, 4>;
            break;
        case 8:
            decoder = new (std::nothrow) Decoder<8000, 8>;
            break;
        default:
            std::cerr << "Unsupported mapping" << std::endl;
            exit(1);
        }
        break;
    case 48000:
        switch (psk) {
        case 2:
            decoder = new (std::nothrow) Decoder<48000, 2>;
            break;
        case 4:
            decoder = new (std::nothrow) Decoder<48000, 4>;
            break;
        case 8:
            decoder = new (std::nothrow) Decoder<48000, 8>;
            break;
        default:
            std::cerr << "Unsupported mapping" << std::endl;
            exit(1);
        }
        break;
    default:
        std::cerr << "Unsupported sample rate: " << sample_rate << std::endl;
        exit(1);
    }
}

int main(int argc, char **argv) {
    int rate = 48000;
    int psk = 4;
    int channel = 0;

    if (argc > 1) rate = std::atoi(argv[1]);
    if (argc > 2) psk = std::atoi(argv[2]);
    if (argc > 3) channel = std::atoi(argv[3]);

    reset_decoder(rate, psk);

    int record_count = rate / 50; // 960 samples for 48000Hz (20ms frames)
    int16_t *buf = new int16_t[record_count];

    // Read raw 16-bit mono PCM samples from standard input
    while (true) {
        size_t bytes_to_read = record_count * sizeof(int16_t);
        size_t total_read = 0;
        char *ptr = reinterpret_cast<char *>(buf);

        while (total_read < bytes_to_read) {
            ssize_t n = read(STDIN_FILENO, ptr + total_read, bytes_to_read - total_read);
            if (n <= 0) {
                // EOF or error
                delete[] buf;
                return 0;
            }
            total_read += n;
        }

        if (decoder->feed(buf, record_count, channel)) {
            int status = decoder->process();
            float cfo = -1.0;
            int32_t mode = -1;
            uint8_t call_sign[192] = {0};
            uint8_t payload[170] = {0};

            switch (status) {
            case 0:
                break;
            case 1:
                std::cout << "EVENT:PREAMBLE_FAIL" << std::endl;
                reset_decoder(rate, psk);
                break;
            case 2:
                decoder->staged(&cfo, &mode, call_sign);
                std::cout << "EVENT:SYNC|CFO:" << cfo << "|MODE:" << mode
                          << "|CALL:" << (reinterpret_cast<char *>(call_sign)) << std::endl;
                break;
            case 3: {
                int flips = decoder->fetch(payload);
                std::cout << "EVENT:MESSAGE|FLIPS:" << flips
                          << "|PAYLOAD:" << (reinterpret_cast<char *>(payload)) << std::endl;
                reset_decoder(rate, psk);
                break;
            }
            case 4:
                std::cout << "EVENT:HEAP_ERROR" << std::endl;
                reset_decoder(rate, psk);
                break;
            case 5:
                decoder->staged(&cfo, &mode, call_sign);
                std::cout << "EVENT:NOPE|CFO:" << cfo << "|MODE:" << mode
                          << "|CALL:" << (reinterpret_cast<char *>(call_sign)) << std::endl;
                break;
            case 6:
                decoder->staged(&cfo, &mode, call_sign);
                std::cout << "EVENT:PING|CFO:" << cfo << "|MODE:" << mode
                          << "|CALL:" << (reinterpret_cast<char *>(call_sign)) << std::endl;
                break;
            default:
                break;
            }
            std::cout.flush();
        }
    }

    delete[] buf;
    return 0;
}
