CREATE DATABASE IF NOT EXISTS dental_appointments;
USE dental_appointments;

-- Drop Instances *
DROP PROCEDURE IF EXISTS sp_get_all_patient_records;
DROP PROCEDURE IF EXISTS sp_get_patient_record;
DROP PROCEDURE IF EXISTS sp_get_employee_record;
DROP PROCEDURE IF EXISTS sp_register_user;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS xrays;
DROP TABLE IF EXISTS patient_documents;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS appointments;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS allergies;
DROP TABLE IF EXISTS prescriptions;
DROP TABLE IF EXISTS health_conditions;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS admin_profiles;
DROP TABLE IF EXISTS employee_profiles;
DROP TABLE IF EXISTS patient_profiles;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    user_id         INT AUTO_INCREMENT PRIMARY KEY,
    public_id       VARCHAR(10) UNIQUE,       
    first_name      VARCHAR(50)  NOT NULL,
    last_name       VARCHAR(50)  NOT NULL,
    email           VARCHAR(150) NOT NULL UNIQUE,
    phone           VARCHAR(20),
    password_hash   VARCHAR(255) NOT NULL,
    sex             VARCHAR(10),
    role            ENUM('patient','employee','admin') NOT NULL,
    account_status  ENUM('active','suspended') NOT NULL DEFAULT 'active',
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Public ID Procedure
DELIMITER $$
CREATE PROCEDURE sp_register_user(
    IN p_first_name  VARCHAR(50),
    IN p_last_name   VARCHAR(50),
    IN p_email       VARCHAR(150),
    IN p_phone       VARCHAR(20),
    IN p_password_hash VARCHAR(255),
    IN p_sex         VARCHAR(10),
    IN p_role        ENUM('patient','employee','admin'),
    OUT p_new_user_id INT
)
BEGIN
    INSERT INTO users (first_name, last_name, email, phone, password_hash, sex, role)
    VALUES (p_first_name, p_last_name, p_email, p_phone, p_password_hash, p_sex, p_role);

    SET p_new_user_id = LAST_INSERT_ID();

    UPDATE users
    SET public_id = CONCAT(
        CASE p_role
            WHEN 'patient'  THEN 'PAT'
            WHEN 'employee' THEN 'EMP'
            WHEN 'admin'    THEN 'ADM'
            ELSE 'USR'
        END,
        '-', LPAD(p_new_user_id, 4, '0')
    )
    WHERE user_id = p_new_user_id;

    -- Every user gets their matching profile row created immediately,
    -- not left for some later step to create — patient_profiles etc.
    -- all have nullable fields, so an empty row here is valid and
    -- expected to be filled in later by the user.
    IF p_role = 'patient' THEN
        INSERT INTO patient_profiles (patient_id) VALUES (p_new_user_id);
    ELSEIF p_role = 'employee' THEN
        INSERT INTO employee_profiles (employee_id) VALUES (p_new_user_id);
    ELSEIF p_role = 'admin' THEN
        INSERT INTO admin_profiles (admin_id) VALUES (p_new_user_id);
    END IF;
END$$
DELIMITER ;

CREATE TABLE patient_profiles (
    patient_id       INT PRIMARY KEY,
    birthday         DATE,
    civil_status     VARCHAR(30),
    secondary_email  VARCHAR(150),
    address          VARCHAR(255),
    pregnancy_status VARCHAR(30),
    FOREIGN KEY (patient_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE employee_profiles (
    employee_id   INT PRIMARY KEY,
    staff_code    VARCHAR(30) UNIQUE,
    position      VARCHAR(30),
    birthday      DATE,
    civil_status  VARCHAR(30),
    FOREIGN KEY (employee_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE admin_profiles (
    admin_id          INT PRIMARY KEY,
    permission_level  VARCHAR(30),
    FOREIGN KEY (admin_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE audit_logs (
    log_id        INT AUTO_INCREMENT PRIMARY KEY,
    admin_id      INT NOT NULL,
    action        VARCHAR(100) NOT NULL,
    target_table  VARCHAR(50)  NOT NULL,
    target_id     INT NOT NULL,
    notes         TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (admin_id) REFERENCES admin_profiles(admin_id) ON DELETE CASCADE
);

CREATE TABLE health_conditions (
    condition_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id    INT NOT NULL,
    description   VARCHAR(255) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE prescriptions (
    prescription_id  INT AUTO_INCREMENT PRIMARY KEY,
    patient_id       INT NOT NULL,
    medication_name  VARCHAR(100) NOT NULL,
    dosage           VARCHAR(50),
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE allergies (
    allergy_id   INT AUTO_INCREMENT PRIMARY KEY,
    patient_id   INT NOT NULL,
    allergen     VARCHAR(100) NOT NULL,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

CREATE TABLE services (
    service_id    INT AUTO_INCREMENT PRIMARY KEY,
    label         VARCHAR(100) NOT NULL,
    price         DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    icon          VARCHAR(255),
    is_available  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE appointments (
    appointment_id      INT AUTO_INCREMENT PRIMARY KEY,
    patient_id          INT NOT NULL,
    employee_id         INT NULL,
    service_id          INT NOT NULL,
    appointment_date    DATE NOT NULL,
    time_slot           TIME NOT NULL,
    appointment_status  ENUM('pending','approved','completed','cancelled') NOT NULL DEFAULT 'pending',
    queue_status         ENUM('pending','waiting','ongoing','completed') NULL,
    patient_note         VARCHAR(255),
    dentist_note          VARCHAR(255),
    created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)  REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (employee_id) REFERENCES employee_profiles(employee_id) ON DELETE SET NULL,
    FOREIGN KEY (service_id)  REFERENCES services(service_id) ON DELETE RESTRICT,
    
    UNIQUE KEY unique_employee_slot (employee_id, appointment_date, time_slot)
);

CREATE TABLE payments (
    payment_id       INT AUTO_INCREMENT PRIMARY KEY,
    appointment_id   INT NOT NULL UNIQUE,
    amount           DECIMAL(10,2) NOT NULL,
    payment_date     DATE,
    method           ENUM('cash','card','online') NOT NULL,
    status           ENUM('pending','paid','refunded') NOT NULL DEFAULT 'pending',
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE
);

CREATE TABLE xrays (
    xray_id         INT AUTO_INCREMENT PRIMARY KEY,
    patient_id      INT NOT NULL,
    appointment_id  INT NULL,
    uploaded_by     INT NOT NULL,
    file_url        VARCHAR(255) NOT NULL,
    uploaded_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id)     REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE SET NULL,
    FOREIGN KEY (uploaded_by)    REFERENCES employee_profiles(employee_id) ON DELETE RESTRICT
);

CREATE TABLE messages (
    message_id   INT AUTO_INCREMENT PRIMARY KEY,
    sender_id    INT NOT NULL,
    receiver_id  INT NOT NULL,
    content      TEXT,
    file_url     VARCHAR(255),
    sent_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_read      BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (sender_id)   REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(user_id) ON DELETE CASCADE
);

CREATE TABLE notifications (
    notification_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id          INT NOT NULL,
    type             VARCHAR(50) NOT NULL,
    title            VARCHAR(100) NOT NULL,
    message          TEXT,
    appointment_id   INT NULL,
    message_id       INT NULL,
    is_read          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id)        REFERENCES users(user_id) ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(appointment_id) ON DELETE CASCADE,
    FOREIGN KEY (message_id)     REFERENCES messages(message_id) ON DELETE CASCADE,
    CONSTRAINT chk_single_source CHECK (
        NOT (appointment_id IS NOT NULL AND message_id IS NOT NULL)
    )
);

CREATE TABLE patient_documents (
    document_id   INT AUTO_INCREMENT PRIMARY KEY,
    patient_id    INT NOT NULL,
    file_url      VARCHAR(255) NOT NULL,
    uploaded_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (patient_id) REFERENCES patient_profiles(patient_id) ON DELETE CASCADE
);

DELIMITER $$
CREATE PROCEDURE sp_get_patient_record(IN p_patient_id INT)
BEGIN
    SELECT JSON_OBJECT(
        'patient_id', pp.patient_id,
        'public_id', u.public_id,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', pp.birthday,
        'email', u.email,
        'phone', u.phone,
        'civil_status', pp.civil_status,
        'pregnancy_status', pp.pregnancy_status,
        'health_conditions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('description', description)), JSON_ARRAY())
            FROM health_conditions WHERE patient_id = pp.patient_id
        ),
        'allergies', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('allergen', allergen)), JSON_ARRAY())
            FROM allergies WHERE patient_id = pp.patient_id
        ),
        'prescriptions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('medication_name', medication_name, 'dosage', dosage)), JSON_ARRAY())
            FROM prescriptions WHERE patient_id = pp.patient_id
        ),
        'xrays', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('xray_id', xray_id, 'appointment_id', appointment_id, 'file_url', file_url)), JSON_ARRAY())
            FROM xrays WHERE patient_id = pp.patient_id
        ),
        'last_visit', (
            SELECT MAX(appointment_date) FROM appointments
            WHERE patient_id = pp.patient_id AND appointment_status = 'completed'
        ),
        'ongoing_appointment', (
            SELECT JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id
              AND a.appointment_status = 'approved'
              AND a.queue_status = 'ongoing'
              AND a.appointment_date = CURDATE()
            ORDER BY a.time_slot DESC
            LIMIT 1
        ),
        'past_appointments', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )), JSON_ARRAY())
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id AND a.appointment_status = 'completed'
        )
    ) AS patient_record
    FROM patient_profiles pp
    JOIN users u ON pp.patient_id = u.user_id
    WHERE pp.patient_id = p_patient_id;
END$$
DELIMITER ;

DELIMITER $$
CREATE PROCEDURE sp_get_all_patient_records()
BEGIN
    SELECT JSON_OBJECT(
        'patient_id', pp.patient_id,
        'public_id', u.public_id,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', pp.birthday,
        'email', u.email,
        'phone', u.phone,
        'civil_status', pp.civil_status,
        'pregnancy_status', pp.pregnancy_status,
        'health_conditions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('description', description)), JSON_ARRAY())
            FROM health_conditions WHERE patient_id = pp.patient_id
        ),
        'allergies', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('allergen', allergen)), JSON_ARRAY())
            FROM allergies WHERE patient_id = pp.patient_id
        ),
        'prescriptions', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('medication_name', medication_name, 'dosage', dosage)), JSON_ARRAY())
            FROM prescriptions WHERE patient_id = pp.patient_id
        ),
        'xrays', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('xray_id', xray_id, 'appointment_id', appointment_id, 'file_url', file_url)), JSON_ARRAY())
            FROM xrays WHERE patient_id = pp.patient_id
        ),
        'last_visit', (
            SELECT MAX(appointment_date) FROM appointments
            WHERE patient_id = pp.patient_id AND appointment_status = 'completed'
        ),
        'ongoing_appointment', (
            SELECT JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id
              AND a.appointment_status = 'approved'
              AND a.queue_status = 'ongoing'
              AND a.appointment_date = CURDATE()
            ORDER BY a.time_slot DESC
            LIMIT 1
        ),
        'past_appointments', (
            SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
                'appointment_id', a.appointment_id,
                'appointment_date', a.appointment_date,
                'service_label', s.label,
                'dentist_note', COALESCE(a.dentist_note, ''),
                'patient_note', COALESCE(a.patient_note, '')
            )), JSON_ARRAY())
            FROM appointments a
            JOIN services s ON a.service_id = s.service_id
            WHERE a.patient_id = pp.patient_id AND a.appointment_status = 'completed'
        )
    ) AS patient_record
    FROM patient_profiles pp
    JOIN users u ON pp.patient_id = u.user_id
    ORDER BY u.user_id;
END$$
DELIMITER ;

DELIMITER $$
CREATE PROCEDURE sp_get_employee_record(IN p_employee_id INT)
BEGIN
    SELECT JSON_OBJECT(
        'employee_id', ep.employee_id,
        'public_id', u.public_id,
        'staff_code', ep.staff_code,
        'position', ep.position,
        'first_name', u.first_name,
        'last_name', u.last_name,
        'sex', u.sex,
        'birthday', ep.birthday,
        'email', u.email,
        'phone', u.phone,
        'civil_status', ep.civil_status
    ) AS employee_record
    FROM employee_profiles ep
    JOIN users u ON ep.employee_id = u.user_id
    WHERE ep.employee_id = p_employee_id;
END$$
DELIMITER ;

-- Double Check
CALL sp_register_user('Maria', 'Santos', 'maria.santos@example.com', '09171234567', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'F', 'patient', @uid1);
CALL sp_register_user('Juan', 'Dela Cruz', 'juan.delacruz@example.com', '09179876543', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'M', 'patient', @uid2);
CALL sp_register_user('Ramon', 'Cruz', 'ramon.cruz@example.com', '09201112222', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'M', 'employee', @uid3);
CALL sp_register_user('Liza', 'Tan', 'liza.tan@example.com', '09203334444', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'F', 'employee', @uid4);
CALL sp_register_user('Carla', 'Reyes', 'carla.reyes@example.com', '09051119999', '$2b$10$PFUiFjV7FngVMIZ2u/chOOV3l.cVQ84nz4Os8DipZlw72yiqAKKJi', 'F', 'admin', @uid5);


UPDATE patient_profiles SET birthday = '1990-04-12', civil_status = 'Single', address = '123 Mabini St, Quezon City' WHERE patient_id = 1;
UPDATE patient_profiles SET birthday = '1985-11-02', civil_status = 'Married', address = '45 Rizal Ave, Manila' WHERE patient_id = 2;

UPDATE employee_profiles SET staff_code = 'STF-2026-001', position = 'Dentist', birthday = '1985-06-10', civil_status = 'Married' WHERE employee_id = 3;
UPDATE employee_profiles SET staff_code = 'STF-2026-002', position = 'Dentist', birthday = '1990-02-20', civil_status = 'Single' WHERE employee_id = 4;

UPDATE admin_profiles SET permission_level = 'full_access' WHERE admin_id = 5;

INSERT INTO services (label, price, icon, is_available) VALUES
('Dental Cleaning', 1500.00, 'cleaning-icon', TRUE),
('Pasta', 2500.00, 'pasta-icon', TRUE),
('Checkup', 500.00, 'checkup-icon', TRUE),
('Whitening', 3000.00, 'whitening-icon', TRUE);

INSERT INTO appointments (patient_id, employee_id, service_id, appointment_date, time_slot, appointment_status, patient_note) VALUES
(1, 3, 1, '2026-09-10', '10:00:00', 'approved', 'First-time patient'),
(2, NULL, 2, '2026-09-12', '11:00:00', 'pending', NULL);

INSERT INTO payments (appointment_id, amount, payment_date, method, status) VALUES
(1, 1500.00, '2026-09-10', 'card', 'paid');

INSERT INTO xrays (patient_id, appointment_id, uploaded_by, file_url) VALUES
(1, 1, 3, '/xrays/patient1_visit1.png');

INSERT INTO messages (sender_id, receiver_id, content, is_read) VALUES
(3, 1, 'Please arrive 10 minutes early for your cleaning.', FALSE);

INSERT INTO notifications (user_id, type, title, message, appointment_id) VALUES
(1, 'appointment_status', 'Appointment Approved', 'Your appointment on 2026-09-10 has been approved.', 1);

INSERT INTO notifications (user_id, type, title, message, message_id) VALUES
(1, 'new_message', 'New Message', 'You have a new message from Dr. Ramon Cruz.', 1);

-- ALTER TABLE FOR OTP IN FORGOT + RESET PASSWORD
ALTER TABLE users
	ADD COLUMN otp			VARCHAR(10) NULL,
    ADD COLUMN otpExpire	DATETIME	NULL;

CALL sp_get_all_patient_records();
select * from users;
select * from appointments;
select a.first_name, b.civil_status  from users a INNER JOIN  employee_profiles b on a.user_id = b.employee_id;
select * from payments;
select a.appointment_id, s.label AS service_offered from appointments a INNER JOIN services s on a.service_id = s.service_id;